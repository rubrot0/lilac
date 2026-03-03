'use client'

import { createTranslateRealtimeClientSecretAction } from '@/app/actions/realtime'
import {
	InputAudioBufferCommittedEventSchema,
	InputAudioTranscriptionCompletedEventSchema,
	InputAudioTranscriptionDeltaEventSchema,
	PublishTranslationToolArgumentsSchema,
	RealtimeBaseServerEventSchema,
	RealtimeErrorEventSchema,
	ResponseDoneEventSchema
} from '@/realtime/schemas'
import type { UtteranceDirection } from '@/realtime/sessionTypes'

export type LiveTranslateRealtimeClientState = 'connecting' | 'connected' | 'disconnected' | 'error'

export type LiveTranslateSourcePatch = {
	inputOrigin: 'audio' | 'text'
	itemId: string
	previousItemId?: null | string
	status: 'final' | 'streaming'
	text: string
}

export type LiveTranslateResultPatch = {
	direction: UtteranceDirection
	inputOrigin: 'audio' | 'text'
	itemId: string
	responseId?: string
	sourceLanguageCode: string
	sourceText: string
	status: 'error' | 'final'
	targetLanguageCode: string
	translatedText: string
}

export type LiveTranslateSettings = {
	primaryLanguageCode: string
	secondaryLanguageCode: string
}

export type StartLiveTranslateRealtimeClientInput = LiveTranslateSettings & {
	model: string
	voiceInputEnabled: boolean
}

export type LiveTranslateRealtimeClientCallbacks = {
	onConnectionStateChange: (state: LiveTranslateRealtimeClientState) => void
	onError: (message: string) => void
	onResultPatch: (patch: LiveTranslateResultPatch) => void
	onSourcePatch: (patch: LiveTranslateSourcePatch) => void
}

type PendingResponseContext = {
	inputOrigin: 'audio' | 'text'
	itemId: string
}

function createClientItemId(prefix: string): string {
	const randomSegment = crypto.randomUUID().replaceAll('-', '').slice(0, 24)
	return `${prefix}_${randomSegment}`
}

function createTranslateInstructions(
	primaryLanguageCode: string,
	secondaryLanguageCode: string
): string {
	return [
		'You are Lilac, a deterministic live translator.',
		`Allowed language pair: ${primaryLanguageCode} and ${secondaryLanguageCode}.`,
		'For each user utterance, detect source language within the pair and translate to the opposite language.',
		'Always call publish_translation exactly once per utterance.',
		'Never produce assistant text outside the function call.',
		'Preserve speaker intent, tone, and named entities.',
		'No summaries, no commentary, no extra fields.'
	].join('\n')
}

function buildPublishTranslationToolDefinition(): Record<string, unknown> {
	return {
		description: 'Publish exactly one translation card for the utterance currently being processed.',
		name: 'publish_translation',
		parameters: {
			additionalProperties: false,
			properties: {
				direction: {
					enum: ['primary_to_secondary', 'secondary_to_primary'],
					type: 'string'
				},
				sourceLanguageCode: {
					type: 'string'
				},
				sourceText: {
					type: 'string'
				},
				targetLanguageCode: {
					type: 'string'
				},
				translatedText: {
					type: 'string'
				}
			},
			required: [
				'sourceText',
				'sourceLanguageCode',
				'targetLanguageCode',
				'translatedText',
				'direction'
			],
			type: 'object'
		},
		type: 'function'
	}
}

function buildToolChoice(): Record<string, string> {
	return {
		name: 'publish_translation',
		type: 'function'
	}
}

function parseStringValue(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const normalizedValue = value.trim()
	if (!normalizedValue) return null
	return normalizedValue
}

export class LiveTranslateRealtimeClient {
	private callbacks: LiveTranslateRealtimeClientCallbacks
	private dataChannel: null | RTCDataChannel = null
	private generation = 0
	private localAudioStream: MediaStream | null = null
	private pendingResponseContextByRequestId = new Map<string, PendingResponseContext>()
	private peerConnection: null | RTCPeerConnection = null
	private sourceItemOrder: string[] = []

	public constructor(callbacks: LiveTranslateRealtimeClientCallbacks) {
		this.callbacks = callbacks
	}

	public async start(input: StartLiveTranslateRealtimeClientInput): Promise<void> {
		this.stop()
		this.generation += 1
		const generation = this.generation
		this.callbacks.onConnectionStateChange('connecting')

		try {
			const clientSecret = await createTranslateRealtimeClientSecretAction({
				model: input.model,
				primaryLanguageCode: input.primaryLanguageCode,
				secondaryLanguageCode: input.secondaryLanguageCode
			})

			if (generation !== this.generation) return

			const peerConnection = new RTCPeerConnection()
			this.peerConnection = peerConnection

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
				this.updateTranslateSettings({
					primaryLanguageCode: input.primaryLanguageCode,
					secondaryLanguageCode: input.secondaryLanguageCode
				})
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
			const fallbackMessage = 'Unable to start Live Translate mode.'
			if (error instanceof Error) this.callbacks.onError(error.message || fallbackMessage)
			else this.callbacks.onError(fallbackMessage)
			this.stop()
		}
	}

	public stop(): void {
		this.generation += 1
		this.pendingResponseContextByRequestId.clear()
		this.sourceItemOrder = []

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
		this.callbacks.onConnectionStateChange('disconnected')
	}

	public submitTextInput(text: string): void {
		const normalizedText = text.trim()
		if (!normalizedText) return
		const itemId = createClientItemId('typed')
		this.registerSourceItem(itemId, null)
		this.callbacks.onSourcePatch({
			inputOrigin: 'text',
			itemId,
			status: 'final',
			text: normalizedText
		})
		this.sendEvent({
			item: {
				content: [
					{
						text: normalizedText,
						type: 'input_text'
					}
				],
				id: itemId,
				role: 'user',
				type: 'message'
			},
			type: 'conversation.item.create'
		})
		this.requestTranslationResponse(itemId, 'text')
	}

	public updateTranslateSettings(settings: LiveTranslateSettings): void {
		this.sendSessionUpdate({
			audio: {
				input: {
					turn_detection: {
						create_response: false,
						interrupt_response: false,
						type: 'semantic_vad'
					}
				}
			},
			instructions: createTranslateInstructions(
				settings.primaryLanguageCode,
				settings.secondaryLanguageCode
			),
			output_modalities: ['text'],
			tool_choice: buildToolChoice(),
			tools: [buildPublishTranslationToolDefinition()]
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

	private buildResponseInput(itemId: string): Array<Record<string, string>> {
		const recentItemIds = this.sourceItemOrder.slice(Math.max(0, this.sourceItemOrder.length - 8))
		if (!recentItemIds.includes(itemId)) recentItemIds.push(itemId)
		return recentItemIds.map(sourceItemId => ({
			id: sourceItemId,
			type: 'item_reference'
		}))
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

	private handleResponseDoneEvent(event: ReturnType<typeof ResponseDoneEventSchema.parse>): void {
		const response = event.response
		if (!response) return

		const metadata = response.metadata ?? {}
		const requestId = parseStringValue(metadata.request_id)
		const sourceItemIdFromMetadata = parseStringValue(metadata.source_item_id)
		const inputOriginFromMetadata = parseStringValue(metadata.input_origin)

		const pendingContext = requestId
			? (this.pendingResponseContextByRequestId.get(requestId) ?? null)
			: null

		const sourceItemId = sourceItemIdFromMetadata ?? pendingContext?.itemId ?? null
		const rawInputOrigin = inputOriginFromMetadata ?? pendingContext?.inputOrigin ?? null
		const inputOrigin: 'audio' | 'text' = rawInputOrigin === 'text' ? 'text' : 'audio'

		if (requestId) this.pendingResponseContextByRequestId.delete(requestId)
		if (!sourceItemId) return

		const functionCall = (response.output ?? []).find(
			item => item.type === 'function_call' && item.name === 'publish_translation'
		)

		const responseId = response.id

		if (!functionCall || typeof functionCall.arguments !== 'string') {
			this.callbacks.onResultPatch({
				direction: 'primary_to_secondary',
				inputOrigin,
				itemId: sourceItemId,
				sourceLanguageCode: 'und',
				sourceText: '',
				status: 'error',
				targetLanguageCode: 'und',
				translatedText: 'No valid publish_translation tool call was returned.',
				...(responseId ? { responseId } : {})
			})
			return
		}

		try {
			const parsedArguments = JSON.parse(functionCall.arguments) as unknown
			const translatedResult = PublishTranslationToolArgumentsSchema.parse(parsedArguments)
			this.callbacks.onResultPatch({
				direction: translatedResult.direction,
				inputOrigin,
				itemId: sourceItemId,
				sourceLanguageCode: translatedResult.sourceLanguageCode,
				sourceText: translatedResult.sourceText,
				status: 'final',
				targetLanguageCode: translatedResult.targetLanguageCode,
				translatedText: translatedResult.translatedText,
				...(responseId ? { responseId } : {})
			})
		} catch {
			this.callbacks.onResultPatch({
				direction: 'primary_to_secondary',
				inputOrigin,
				itemId: sourceItemId,
				sourceLanguageCode: 'und',
				sourceText: '',
				status: 'error',
				targetLanguageCode: 'und',
				translatedText: 'Tool arguments were malformed and could not be parsed.',
				...(responseId ? { responseId } : {})
			})
		}
	}

	private handleServerEvent(rawData: unknown): void {
		try {
			const candidate = typeof rawData === 'string' ? JSON.parse(rawData) : rawData
			const baseEvent = RealtimeBaseServerEventSchema.parse(candidate)

			switch (baseEvent.type) {
				case 'input_audio_buffer.committed': {
					const event = InputAudioBufferCommittedEventSchema.parse(candidate)
					this.registerSourceItem(event.item_id, event.previous_item_id ?? null)
					this.callbacks.onSourcePatch({
						inputOrigin: 'audio',
						itemId: event.item_id,
						previousItemId: event.previous_item_id ?? null,
						status: 'streaming',
						text: ''
					})
					this.requestTranslationResponse(event.item_id, 'audio')
					return
				}
				case 'conversation.item.input_audio_transcription.delta': {
					const event = InputAudioTranscriptionDeltaEventSchema.parse(candidate)
					this.callbacks.onSourcePatch({
						inputOrigin: 'audio',
						itemId: event.item_id,
						status: 'streaming',
						text: event.delta
					})
					return
				}
				case 'conversation.item.input_audio_transcription.completed': {
					const event = InputAudioTranscriptionCompletedEventSchema.parse(candidate)
					this.callbacks.onSourcePatch({
						inputOrigin: 'audio',
						itemId: event.item_id,
						status: 'final',
						text: event.transcript
					})
					return
				}
				case 'response.done': {
					const event = ResponseDoneEventSchema.parse(candidate)
					this.handleResponseDoneEvent(event)
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
			// Ignore unrelated/unrecognized realtime events.
			return
		}
	}

	private registerSourceItem(itemId: string, previousItemId: null | string): void {
		if (this.sourceItemOrder.includes(itemId)) return
		if (!previousItemId) {
			this.sourceItemOrder.push(itemId)
			return
		}

		const previousIndex = this.sourceItemOrder.indexOf(previousItemId)
		if (previousIndex === -1) {
			this.sourceItemOrder.push(itemId)
		} else {
			this.sourceItemOrder.splice(previousIndex + 1, 0, itemId)
		}
		if (this.sourceItemOrder.length > 48) {
			this.sourceItemOrder = this.sourceItemOrder.slice(this.sourceItemOrder.length - 48)
		}
	}

	private requestTranslationResponse(itemId: string, inputOrigin: 'audio' | 'text'): void {
		const requestId = crypto.randomUUID()
		this.pendingResponseContextByRequestId.set(requestId, { inputOrigin, itemId })
		this.sendEvent({
			response: {
				conversation: 'none',
				input: this.buildResponseInput(itemId),
				metadata: {
					input_origin: inputOrigin,
					request_id: requestId,
					source_item_id: itemId
				},
				output_modalities: ['text'],
				tool_choice: buildToolChoice(),
				tools: [buildPublishTranslationToolDefinition()]
			},
			type: 'response.create'
		})
	}

	private sendSessionUpdate(sessionPatch: Record<string, unknown>): void {
		this.sendEvent({
			session: {
				type: 'realtime',
				...sessionPatch
			},
			type: 'session.update'
		})
	}

	private sendEvent(event: Record<string, unknown>): void {
		if (!this.dataChannel) return
		if (this.dataChannel.readyState !== 'open') return
		try {
			this.dataChannel.send(JSON.stringify(event))
		} catch {}
	}
}
