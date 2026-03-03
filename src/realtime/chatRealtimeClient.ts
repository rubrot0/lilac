'use client'

import { createRealtimeClientSecretAction } from '@/app/actions/realtime'
import {
	InputAudioTranscriptionCompletedEventSchema,
	InputAudioTranscriptionDeltaEventSchema,
	RealtimeBaseServerEventSchema,
	RealtimeErrorEventSchema,
	ResponseDoneEventSchema,
	ResponseOutputAudioTranscriptDeltaEventSchema,
	ResponseOutputItemAddedEventSchema,
	ResponseOutputTextDeltaEventSchema,
	ResponseOutputTextDoneEventSchema
} from '@/realtime/schemas'
import type { ChatTranscriptSource } from '@/realtime/sessionTypes'

export type ChatTranscriptPatch = {
	appendText?: string
	id: string
	replaceText?: string
	role: 'assistant' | 'user'
	source: ChatTranscriptSource
	status?: 'final' | 'streaming'
}

export type ChatRealtimeClientState = 'connecting' | 'connected' | 'disconnected' | 'error'

export type StartChatRealtimeClientInput = {
	instructions: string
	model: string
	speechOutputEnabled: boolean
	turnDelaySeconds: number
	voice: string
	voiceInputEnabled: boolean
}

export type ChatRealtimeClientCallbacks = {
	onConnectionStateChange: (state: ChatRealtimeClientState) => void
	onError: (message: string) => void
	onRemoteStream: (stream: MediaStream | null) => void
	onTranscriptPatch: (patch: ChatTranscriptPatch) => void
}

export class ChatRealtimeClient {
	private assistantItemIdByResponseId = new Map<string, string>()
	private callbacks: ChatRealtimeClientCallbacks
	private dataChannel: null | RTCDataChannel = null
	private generation = 0
	private localAudioStream: MediaStream | null = null
	private pendingAudioTranscriptByResponseId = new Map<string, string>()
	private pendingTextByResponseId = new Map<string, string>()
	private peerConnection: null | RTCPeerConnection = null

	public constructor(callbacks: ChatRealtimeClientCallbacks) {
		this.callbacks = callbacks
	}

	public async start(input: StartChatRealtimeClientInput): Promise<void> {
		this.stop()
		this.generation += 1
		const generation = this.generation
		this.callbacks.onConnectionStateChange('connecting')

		try {
			const clientSecret = await createRealtimeClientSecretAction({
				instructions: input.instructions,
				model: input.model,
				speechOutputEnabled: input.speechOutputEnabled,
				turnDelaySeconds: input.turnDelaySeconds,
				voice: input.voice
			})

			if (generation !== this.generation) return

			const peerConnection = new RTCPeerConnection()
			this.peerConnection = peerConnection

			peerConnection.addEventListener('track', event => {
				const firstStream = event.streams[0]
				if (!firstStream) return
				this.callbacks.onRemoteStream(firstStream)
			})

			if (input.voiceInputEnabled) {
				await this.enableVoiceInput(generation)
			}

			if (generation !== this.generation) return

			const localAudioStream = this.localAudioStream
			if (localAudioStream) {
				for (const track of localAudioStream.getTracks()) {
					peerConnection.addTrack(track, localAudioStream)
				}
			}

			const dataChannel = peerConnection.createDataChannel('oai-events')
			this.dataChannel = dataChannel

			dataChannel.addEventListener('open', () => {
				if (generation !== this.generation) return
				this.callbacks.onConnectionStateChange('connected')
			})

			dataChannel.addEventListener('close', () => {
				if (generation !== this.generation) return
				this.callbacks.onConnectionStateChange('disconnected')
			})

			dataChannel.addEventListener('message', event => {
				this.handleServerEvent(event.data)
			})

			const offer = await peerConnection.createOffer()
			await peerConnection.setLocalDescription(offer)

			if (generation !== this.generation) return

			const response = await fetch('https://api.openai.com/v1/realtime/calls', {
				body: offer.sdp ?? '',
				headers: {
					Authorization: `Bearer ${clientSecret.value}`,
					'Content-Type': 'application/sdp'
				},
				method: 'POST'
			})

			if (!response.ok) {
				const message = await response.text().catch(() => '')
				throw new Error(message || `Realtime call handshake failed (${response.status})`)
			}

			const answerSdp = await response.text()
			if (generation !== this.generation) return
			await peerConnection.setRemoteDescription({ sdp: answerSdp, type: 'answer' })
		} catch (error) {
			if (generation !== this.generation) return
			this.callbacks.onConnectionStateChange('error')
			const fallbackMessage = 'Unable to start Chat mode.'
			if (error instanceof Error) this.callbacks.onError(error.message || fallbackMessage)
			else this.callbacks.onError(fallbackMessage)
			this.stop()
		}
	}

	public stop(): void {
		this.generation += 1
		this.assistantItemIdByResponseId.clear()
		this.pendingTextByResponseId.clear()
		this.pendingAudioTranscriptByResponseId.clear()

		try {
			this.dataChannel?.close()
		} catch {}
		this.dataChannel = null

		try {
			this.peerConnection?.close()
		} catch {}
		this.peerConnection = null

		for (const track of this.localAudioStream?.getTracks() ?? []) {
			track.stop()
		}
		this.localAudioStream = null
		this.callbacks.onRemoteStream(null)
		this.callbacks.onConnectionStateChange('disconnected')
	}

	public submitTextInput(text: string): void {
		const normalizedText = text.trim()
		if (!normalizedText) return
		this.sendEvent({
			item: {
				content: [
					{
						text: normalizedText,
						type: 'input_text'
					}
				],
				role: 'user',
				type: 'message'
			},
			type: 'conversation.item.create'
		})
		this.sendEvent({
			type: 'response.create'
		})
	}

	public updateInstructions(instructions: string): void {
		this.sendEvent({
			session: { instructions },
			type: 'session.update'
		})
	}

	public updateSpeechOutputEnabled(speechOutputEnabled: boolean): void {
		this.sendEvent({
			session: {
				output_modalities: [speechOutputEnabled ? 'audio' : 'text']
			},
			type: 'session.update'
		})
		if (!speechOutputEnabled) this.callbacks.onRemoteStream(null)
	}

	public updateTurnDelaySeconds(turnDelaySeconds: number): void {
		const silenceDurationMilliseconds = Math.round(turnDelaySeconds * 1000)
		this.sendEvent({
			session: {
				audio: {
					input: {
						turn_detection: {
							silence_duration_ms: silenceDurationMilliseconds,
							type: 'server_vad'
						}
					}
				}
			},
			type: 'session.update'
		})
	}

	public async updateVoiceInputEnabled(voiceInputEnabled: boolean): Promise<void> {
		if (!this.peerConnection) return
		const generation = this.generation

		if (!voiceInputEnabled) {
			for (const sender of this.peerConnection.getSenders()) {
				if (sender.track?.kind === 'audio') {
					try {
						this.peerConnection.removeTrack(sender)
					} catch {}
				}
			}
			for (const track of this.localAudioStream?.getTracks() ?? []) {
				track.stop()
			}
			this.localAudioStream = null
			return
		}

		const hasLocalAudioStream = this.localAudioStream !== null
		if (hasLocalAudioStream) return
		await this.enableVoiceInput(generation)
		if (generation !== this.generation) return
		const localAudioStream = this.localAudioStream
		if (localAudioStream === null) return
		for (const track of localAudioStream.getTracks()) {
			this.peerConnection.addTrack(track, localAudioStream)
		}
	}

	private async enableVoiceInput(generation: number): Promise<void> {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				autoGainControl: true,
				echoCancellation: true,
				noiseSuppression: true
			}
		})
		if (generation !== this.generation) {
			for (const track of stream.getTracks()) track.stop()
			return
		}
		this.localAudioStream = stream
	}

	private emitTranscriptPatch(patch: ChatTranscriptPatch): void {
		this.callbacks.onTranscriptPatch(patch)
	}

	private finalizeAssistantForResponse(responseId: string | undefined): void {
		if (!responseId) return
		const itemId = this.assistantItemIdByResponseId.get(responseId)
		if (!itemId) return
		this.emitTranscriptPatch({
			id: itemId,
			role: 'assistant',
			source: 'response_output_text',
			status: 'final'
		})
	}

	private handleServerEvent(rawData: unknown): void {
		try {
			const candidate = typeof rawData === 'string' ? JSON.parse(rawData) : rawData
			const baseEvent = RealtimeBaseServerEventSchema.parse(candidate)

			switch (baseEvent.type) {
				case 'conversation.item.input_audio_transcription.delta': {
					const event = InputAudioTranscriptionDeltaEventSchema.parse(candidate)
					if (!event.delta.trim()) return
					this.emitTranscriptPatch({
						appendText: event.delta,
						id: event.item_id,
						role: 'user',
						source: 'input_transcription',
						status: 'streaming'
					})
					return
				}
				case 'conversation.item.input_audio_transcription.completed': {
					const event = InputAudioTranscriptionCompletedEventSchema.parse(candidate)
					this.emitTranscriptPatch({
						id: event.item_id,
						replaceText: event.transcript,
						role: 'user',
						source: 'input_transcription',
						status: 'final'
					})
					return
				}
				case 'response.output_item.added': {
					const event = ResponseOutputItemAddedEventSchema.parse(candidate)
					if (!event.response_id) return
					this.assistantItemIdByResponseId.set(event.response_id, event.item.id)

					const pendingText = this.pendingTextByResponseId.get(event.response_id)
					if (pendingText) {
						this.emitTranscriptPatch({
							appendText: pendingText,
							id: event.item.id,
							role: 'assistant',
							source: 'response_output_text',
							status: 'streaming'
						})
						this.pendingTextByResponseId.delete(event.response_id)
					}

					const pendingAudioTranscript = this.pendingAudioTranscriptByResponseId.get(event.response_id)
					if (pendingAudioTranscript) {
						this.emitTranscriptPatch({
							appendText: pendingAudioTranscript,
							id: event.item.id,
							role: 'assistant',
							source: 'response_output_audio_transcript',
							status: 'streaming'
						})
						this.pendingAudioTranscriptByResponseId.delete(event.response_id)
					}
					return
				}
				case 'response.output_text.delta': {
					const event = ResponseOutputTextDeltaEventSchema.parse(candidate)
					const assistantItemId =
						event.item_id ??
						(event.response_id ? this.assistantItemIdByResponseId.get(event.response_id) : undefined)
					if (!assistantItemId && event.response_id) {
						const previousPending = this.pendingTextByResponseId.get(event.response_id) ?? ''
						this.pendingTextByResponseId.set(event.response_id, `${previousPending}${event.delta}`)
						return
					}
					if (!assistantItemId) return
					this.emitTranscriptPatch({
						appendText: event.delta,
						id: assistantItemId,
						role: 'assistant',
						source: 'response_output_text',
						status: 'streaming'
					})
					return
				}
				case 'response.output_audio_transcript.delta': {
					const event = ResponseOutputAudioTranscriptDeltaEventSchema.parse(candidate)
					const assistantItemId =
						event.item_id ??
						(event.response_id ? this.assistantItemIdByResponseId.get(event.response_id) : undefined)
					if (!assistantItemId && event.response_id) {
						const previousPending = this.pendingAudioTranscriptByResponseId.get(event.response_id) ?? ''
						this.pendingAudioTranscriptByResponseId.set(
							event.response_id,
							`${previousPending}${event.delta}`
						)
						return
					}
					if (!assistantItemId) return
					this.emitTranscriptPatch({
						appendText: event.delta,
						id: assistantItemId,
						role: 'assistant',
						source: 'response_output_audio_transcript',
						status: 'streaming'
					})
					return
				}
				case 'response.output_text.done': {
					const event = ResponseOutputTextDoneEventSchema.parse(candidate)
					const assistantItemId =
						event.item_id ??
						(event.response_id ? this.assistantItemIdByResponseId.get(event.response_id) : undefined)
					if (!assistantItemId) return
					if (typeof event.text === 'string' && event.text.trim()) {
						this.emitTranscriptPatch({
							id: assistantItemId,
							replaceText: event.text,
							role: 'assistant',
							source: 'response_output_text',
							status: 'final'
						})
						return
					}
					this.emitTranscriptPatch({
						id: assistantItemId,
						role: 'assistant',
						source: 'response_output_text',
						status: 'final'
					})
					return
				}
				case 'response.done': {
					const event = ResponseDoneEventSchema.parse(candidate)
					this.finalizeAssistantForResponse(event.response_id ?? event.response?.id)
					return
				}
				case 'error': {
					const event = RealtimeErrorEventSchema.parse(candidate)
					this.callbacks.onError(event.error?.message || 'Realtime session error')
					return
				}
				default:
					return
			}
		} catch {
			// Ignore unrecognized event payloads; the Realtime stream can contain event shapes
			// that this client does not need for transcript rendering.
			return
		}
	}

	private sendEvent(event: Record<string, unknown>): void {
		if (!this.dataChannel) return
		if (this.dataChannel.readyState !== 'open') return
		try {
			this.dataChannel.send(JSON.stringify(event))
		} catch {}
	}
}
