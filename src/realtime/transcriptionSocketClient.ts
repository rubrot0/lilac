'use client'

import { createRealtimeTranscriptionSessionAction } from '@/app/actions/realtime'
import {
	InputAudioBufferCommittedEventSchema,
	InputAudioTranscriptionCompletedEventSchema,
	InputAudioTranscriptionDeltaEventSchema,
	RealtimeBaseServerEventSchema
} from '@/realtime/schemas'

export type TranscriptionSocketClientState = 'connecting' | 'connected' | 'disconnected' | 'error'

export type TranscriptionPatch = {
	itemId: string
	previousItemId?: null | string
	status: 'final' | 'streaming'
	text: string
}

export type StartTranscriptionSocketClientInput = {
	languageHint?: string
	model: string
	turnDelaySeconds: number
}

export type TranscriptionSocketClientCallbacks = {
	onConnectionStateChange: (state: TranscriptionSocketClientState) => void
	onError: (message: string) => void
	onPatch: (patch: TranscriptionPatch) => void
}

function float32ToPcm16(float32Samples: Float32Array): ArrayBuffer {
	const pcm16 = new Int16Array(float32Samples.length)
	for (let sampleIndex = 0; sampleIndex < float32Samples.length; sampleIndex += 1) {
		const sample = Math.max(-1, Math.min(1, float32Samples[sampleIndex] ?? 0))
		pcm16[sampleIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
	}
	return pcm16.buffer
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = ''
	const bytes = new Uint8Array(buffer)
	for (let index = 0; index < bytes.length; index += 1) {
		binary += String.fromCharCode(bytes[index] ?? 0)
	}
	return window.btoa(binary)
}

function downsampleFloat32Audio(
	float32Samples: Float32Array,
	inputSampleRate: number,
	outputSampleRate: number
): Float32Array {
	if (inputSampleRate === outputSampleRate) return float32Samples

	const sampleRateRatio = inputSampleRate / outputSampleRate
	const downsampledLength = Math.max(1, Math.round(float32Samples.length / sampleRateRatio))
	const downsampledSamples = new Float32Array(downsampledLength)

	let sourceIndex = 0
	for (let outputIndex = 0; outputIndex < downsampledLength; outputIndex += 1) {
		const nextSourceIndex = Math.round((outputIndex + 1) * sampleRateRatio)
		let accumulator = 0
		let sampleCount = 0

		while (sourceIndex < nextSourceIndex && sourceIndex < float32Samples.length) {
			accumulator += float32Samples[sourceIndex] ?? 0
			sampleCount += 1
			sourceIndex += 1
		}

		if (sampleCount > 0) {
			downsampledSamples[outputIndex] = accumulator / sampleCount
			continue
		}

		const fallbackSourceIndex = Math.min(
			float32Samples.length - 1,
			Math.round(outputIndex * sampleRateRatio)
		)
		downsampledSamples[outputIndex] = float32Samples[fallbackSourceIndex] ?? 0
	}

	return downsampledSamples
}

export class TranscriptionSocketClient {
	private audioContext: AudioContext | null = null
	private audioProcessor: ScriptProcessorNode | null = null
	private audioSource: MediaStreamAudioSourceNode | null = null
	private callbacks: TranscriptionSocketClientCallbacks
	private generation = 0
	private microphoneStream: MediaStream | null = null
	private websocket: WebSocket | null = null

	public constructor(callbacks: TranscriptionSocketClientCallbacks) {
		this.callbacks = callbacks
	}

	public async start(input: StartTranscriptionSocketClientInput): Promise<void> {
		this.stop()
		this.generation += 1
		const generation = this.generation
		this.callbacks.onConnectionStateChange('connecting')

		try {
			const clientSecret = await createRealtimeTranscriptionSessionAction({
				languageHint: input.languageHint,
				model: input.model,
				turnDelaySeconds: input.turnDelaySeconds
			})

			if (generation !== this.generation) return

			const websocketProtocols = ['realtime', `openai-insecure-api-key.${clientSecret.value}`]
			const websocket = new WebSocket(
				'wss://api.openai.com/v1/realtime?intent=transcription',
				websocketProtocols
			)
			this.websocket = websocket

			websocket.addEventListener('open', () => {
				if (generation !== this.generation) return
				this.callbacks.onConnectionStateChange('connected')
				this.sendEvent({
					session: {
						audio: {
							input: {
								format: {
									rate: 24000,
									type: 'audio/pcm'
								},
								noise_reduction: {
									type: 'near_field'
								},
								transcription: {
									model: input.model,
									...(input.languageHint ? { language: input.languageHint } : {})
								},
								turn_detection: {
									create_response: false,
									interrupt_response: false,
									silence_duration_ms: Math.round(input.turnDelaySeconds * 1000),
									type: 'server_vad'
								}
							}
						},
						type: 'transcription'
					},
					type: 'transcription_session.update'
				})
			})

			websocket.addEventListener('message', event => {
				this.handleRealtimeEvent(event.data)
			})

			websocket.addEventListener('error', () => {
				if (generation !== this.generation) return
				this.callbacks.onConnectionStateChange('error')
				this.callbacks.onError('Realtime transcription socket error')
			})

			websocket.addEventListener('close', () => {
				if (generation !== this.generation) return
				this.callbacks.onConnectionStateChange('disconnected')
			})

			await this.startMicrophoneStreaming(generation)
		} catch (error) {
			if (generation !== this.generation) return
			const fallbackMessage = 'Unable to start transcription mode.'
			if (error instanceof Error) this.callbacks.onError(error.message || fallbackMessage)
			else this.callbacks.onError(fallbackMessage)
			this.callbacks.onConnectionStateChange('error')
			this.stop()
		}
	}

	public stop(): void {
		this.generation += 1

		try {
			this.websocket?.close()
		} catch {}
		this.websocket = null

		try {
			this.audioProcessor?.disconnect()
		} catch {}
		this.audioProcessor = null

		try {
			this.audioSource?.disconnect()
		} catch {}
		this.audioSource = null

		for (const track of this.microphoneStream?.getTracks() ?? []) {
			track.stop()
		}
		this.microphoneStream = null

		if (this.audioContext) {
			void this.audioContext.close().catch(() => {})
		}
		this.audioContext = null

		this.callbacks.onConnectionStateChange('disconnected')
	}

	private handleRealtimeEvent(rawData: unknown): void {
		try {
			const candidate = typeof rawData === 'string' ? JSON.parse(rawData) : rawData
			const baseEvent = RealtimeBaseServerEventSchema.parse(candidate)

			switch (baseEvent.type) {
				case 'input_audio_buffer.committed': {
					const event = InputAudioBufferCommittedEventSchema.parse(candidate)
					const previousItemId =
						typeof candidate === 'object' &&
						candidate !== null &&
						'previous_item_id' in candidate &&
						typeof (candidate as { previous_item_id?: unknown }).previous_item_id === 'string'
							? ((candidate as { previous_item_id: string }).previous_item_id ?? null)
							: null
					this.callbacks.onPatch({
						itemId: event.item_id,
						previousItemId,
						status: 'streaming',
						text: ''
					})
					return
				}
				case 'conversation.item.input_audio_transcription.delta': {
					const event = InputAudioTranscriptionDeltaEventSchema.parse(candidate)
					this.callbacks.onPatch({
						itemId: event.item_id,
						status: 'streaming',
						text: event.delta
					})
					return
				}
				case 'conversation.item.input_audio_transcription.completed': {
					const event = InputAudioTranscriptionCompletedEventSchema.parse(candidate)
					this.callbacks.onPatch({
						itemId: event.item_id,
						status: 'final',
						text: event.transcript
					})
					return
				}
				case 'error': {
					const message =
						typeof candidate === 'object' &&
						candidate !== null &&
						'error' in candidate &&
						typeof (candidate as { error?: { message?: unknown } }).error?.message === 'string'
							? ((candidate as { error?: { message?: string } }).error?.message ??
								'Realtime transcription error')
							: 'Realtime transcription error'
					this.callbacks.onError(message)
					return
				}
				default:
					return
			}
		} catch {
			this.callbacks.onError('Failed to parse transcription event payload')
		}
	}

	private sendEvent(event: Record<string, unknown>): void {
		if (!this.websocket) return
		if (this.websocket.readyState !== WebSocket.OPEN) return
		try {
			this.websocket.send(JSON.stringify(event))
		} catch {}
	}

	private async startMicrophoneStreaming(generation: number): Promise<void> {
		const microphoneStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				autoGainControl: true,
				echoCancellation: true,
				noiseSuppression: true
			}
		})

		if (generation !== this.generation) {
			for (const track of microphoneStream.getTracks()) track.stop()
			return
		}

		this.microphoneStream = microphoneStream

		const AudioContextConstructor =
			window.AudioContext ??
			(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
		if (!AudioContextConstructor) throw new Error('AudioContext is not supported in this browser')

		const audioContext = new AudioContextConstructor()
		if (audioContext.state === 'suspended') await audioContext.resume()
		if (generation !== this.generation) return

		this.audioContext = audioContext

		const audioSource = audioContext.createMediaStreamSource(microphoneStream)
		const audioProcessor = audioContext.createScriptProcessor(4096, 1, 1)
		this.audioSource = audioSource
		this.audioProcessor = audioProcessor

		audioProcessor.onaudioprocess = event => {
			if (generation !== this.generation) return
			const float32Samples = event.inputBuffer.getChannelData(0)
			if (!float32Samples.length) return
			const downsampled = downsampleFloat32Audio(float32Samples, audioContext.sampleRate, 24000)
			const pcm16Buffer = float32ToPcm16(downsampled)
			const base64Audio = arrayBufferToBase64(pcm16Buffer)
			this.sendEvent({
				audio: base64Audio,
				type: 'input_audio_buffer.append'
			})
		}

		audioSource.connect(audioProcessor)
		audioProcessor.connect(audioContext.destination)
	}
}
