'use client'

import { createRealtimeTranscriptionSessionAction } from '@/app/actions/realtime'
import { resolveRealtimeTranscriptionLanguageCode } from '@/realtime/languageCatalog'
import { resolveTranscriptionModelFromEnvironment } from '@/realtime/modelConfig'
import {
	InputAudioBufferCommittedEventSchema,
	InputAudioBufferSpeechStartedEventSchema,
	InputAudioBufferSpeechStoppedEventSchema,
	InputAudioTranscriptionCompletedEventSchema,
	InputAudioTranscriptionDeltaEventSchema,
	RealtimeBaseServerEventSchema,
	RealtimeErrorEventSchema
} from '@/realtime/schemas'

export type SubtitleTranscriptionClientState = 'connecting' | 'connected' | 'disconnected' | 'error'

export type SubtitleTranscriptionSettings = {
	myLanguageCode: string
	translateToLanguageCode: string
}

export type StartSubtitleTranscriptionClientInput = SubtitleTranscriptionSettings & {
	voiceInputEnabled: boolean
}

export type SubtitleDeltaPatch = {
	itemId: string
	previousItemId?: null | string
	textDelta: string
}

export type SubtitleFinalPatch = {
	audioPcm16Data?: Int16Array
	committedAt: number
	confidence?: number
	itemId: string
	previousItemId?: null | string
	segmentSequence: number
	text: string
}

export type SubtitleTranscriptionClientCallbacks = {
	onConnectionStateChange: (state: SubtitleTranscriptionClientState) => void
	onError: (message: string) => void
	onListeningStateChange: (isListening: boolean) => void
	onSubtitleDelta: (patch: SubtitleDeltaPatch) => void
	onSubtitleFinal: (patch: SubtitleFinalPatch) => void
}

function parsePositiveIntegerEnvironmentValue(
	name: string,
	fallbackValue: number,
	bounds: { maximum: number; minimum: number }
): number {
	const rawValue = process.env[name]
	if (!rawValue) return fallbackValue
	const parsedValue = Number.parseInt(rawValue, 10)
	if (!Number.isFinite(parsedValue)) return fallbackValue
	return Math.max(bounds.minimum, Math.min(bounds.maximum, parsedValue))
}

function parsePositiveFloatEnvironmentValue(
	name: string,
	fallbackValue: number,
	bounds: { maximum: number; minimum: number }
): number {
	const rawValue = process.env[name]
	if (!rawValue) return fallbackValue
	const parsedValue = Number.parseFloat(rawValue)
	if (!Number.isFinite(parsedValue)) return fallbackValue
	return Math.max(bounds.minimum, Math.min(bounds.maximum, parsedValue))
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim()
}

function isAsciiDigitCharacter(value: string): boolean {
	return value >= '0' && value <= '9'
}

function isUnicodeLetterCharacter(value: string): boolean {
	return value.toLowerCase() !== value.toUpperCase()
}

function countTranscriptSignalCharacters(value: string): number {
	let signalCharacterCount = 0
	for (const character of value) {
		if (isAsciiDigitCharacter(character) || isUnicodeLetterCharacter(character)) {
			signalCharacterCount += 1
		}
	}
	return signalCharacterCount
}

function countTranscriptWordList(value: string): number {
	const normalizedValue = normalizeWhitespace(value)
	if (!normalizedValue) return 0
	return normalizedValue.split(' ').filter(Boolean).length
}

function shouldDropLowSignalTranscript(input: {
	audioDurationMilliseconds: undefined | number
	confidence: undefined | number
	transcript: string
}): boolean {
	const normalizedTranscript = normalizeWhitespace(input.transcript)
	if (!normalizedTranscript) return true
	const signalCharacterCount = countTranscriptSignalCharacters(normalizedTranscript)
	const wordCount = countTranscriptWordList(normalizedTranscript)
	const audioDurationMilliseconds = input.audioDurationMilliseconds ?? Number.POSITIVE_INFINITY
	const confidence = input.confidence ?? 1
	if (signalCharacterCount <= 1 && audioDurationMilliseconds < 700) return true
	if (wordCount <= 1 && audioDurationMilliseconds < 260) return true
	if (
		wordCount <= 1 &&
		signalCharacterCount < 3 &&
		audioDurationMilliseconds < 420 &&
		confidence < 0.72
	) {
		return true
	}
	if (signalCharacterCount < 3 && audioDurationMilliseconds < 700 && confidence < 0.6) return true
	return false
}

function createTranscriptionSessionPatch(input: {
	settings: SubtitleTranscriptionSettings
}): Record<string, unknown> {
	const transcriptionModel = resolveTranscriptionModelFromEnvironment(
		resolveAsrProfileFromEnvironment()
	)
	const languageCode = resolveRealtimeTranscriptionLanguageCode(input.settings.myLanguageCode)
	return {
		include: ['item.input_audio_transcription.logprobs'],
		input_audio_format: 'pcm16',
		input_audio_noise_reduction: {
			type: 'near_field'
		},
		input_audio_transcription: {
			model: transcriptionModel,
			...(languageCode ? { language: languageCode } : {})
		},
		turn_detection: null
	}
}

function clampPcmSample(value: number): number {
	if (value > 1) return 1
	if (value < -1) return -1
	return value
}

function convertFloat32ToInt16(
	inputBuffer: Float32Array,
	inputSampleRate: number,
	outputSampleRate: number
): Int16Array {
	if (inputSampleRate === outputSampleRate) {
		const directResult = new Int16Array(inputBuffer.length)
		for (let sampleIndex = 0; sampleIndex < inputBuffer.length; sampleIndex += 1) {
			const normalizedSample = clampPcmSample(inputBuffer[sampleIndex] ?? 0)
			directResult[sampleIndex] =
				normalizedSample < 0
					? Math.round(normalizedSample * 0x8000)
					: Math.round(normalizedSample * 0x7fff)
		}
		return directResult
	}

	const sampleRateRatio = inputSampleRate / outputSampleRate
	const outputLength = Math.max(1, Math.floor(inputBuffer.length / sampleRateRatio))
	const outputBuffer = new Int16Array(outputLength)
	let sourceIndex = 0

	for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
		const nextSourceIndex = Math.min(
			inputBuffer.length,
			Math.floor((outputIndex + 1) * sampleRateRatio)
		)
		let sampleAccumulator = 0
		let sampleCount = 0
		for (
			let accumulatorIndex = sourceIndex;
			accumulatorIndex < nextSourceIndex;
			accumulatorIndex += 1
		) {
			sampleAccumulator += inputBuffer[accumulatorIndex] ?? 0
			sampleCount += 1
		}
		const averageSample = sampleCount > 0 ? sampleAccumulator / sampleCount : 0
		const normalizedSample = clampPcmSample(averageSample)
		outputBuffer[outputIndex] =
			normalizedSample < 0
				? Math.round(normalizedSample * 0x8000)
				: Math.round(normalizedSample * 0x7fff)
		sourceIndex = nextSourceIndex
	}

	return outputBuffer
}

function int16ArrayToBase64(inputArray: Int16Array): string {
	const byteView = new Uint8Array(inputArray.buffer)
	const chunkSize = 0x8000
	let binaryString = ''
	for (let offset = 0; offset < byteView.length; offset += chunkSize) {
		const chunk = byteView.subarray(offset, offset + chunkSize)
		let chunkString = ''
		for (let byteIndex = 0; byteIndex < chunk.length; byteIndex += 1) {
			chunkString += String.fromCharCode(chunk[byteIndex] ?? 0)
		}
		binaryString += chunkString
	}
	return btoa(binaryString)
}

function concatInt16ArrayList(inputList: Int16Array[]): Int16Array {
	const totalLength = inputList.reduce((sum, inputArray) => sum + inputArray.length, 0)
	const outputArray = new Int16Array(totalLength)
	let outputOffset = 0
	for (const inputArray of inputList) {
		outputArray.set(inputArray, outputOffset)
		outputOffset += inputArray.length
	}
	return outputArray
}

function resolveAsrProfileFromEnvironment(): 'accurate' | 'fast' {
	return process.env.NEXT_PUBLIC_LILAC_TRANSCRIBE_ASR_PROFILE === 'fast' ? 'fast' : 'accurate'
}

function computeConfidenceFromLogprobs(
	logprobList: Array<Record<string, unknown>> | undefined
): number | undefined {
	if (!Array.isArray(logprobList) || logprobList.length === 0) return undefined
	let normalizedProbabilitySum = 0
	let normalizedProbabilityCount = 0
	for (const logprobEntry of logprobList) {
		const logprobValue = typeof logprobEntry.logprob === 'number' ? logprobEntry.logprob : undefined
		if (typeof logprobValue !== 'number' || !Number.isFinite(logprobValue)) continue
		const clampedLogprob = Math.max(-20, Math.min(0, logprobValue))
		const normalizedProbability = Math.exp(clampedLogprob)
		normalizedProbabilitySum += normalizedProbability
		normalizedProbabilityCount += 1
	}
	if (normalizedProbabilityCount === 0) return undefined
	return Math.round((normalizedProbabilitySum / normalizedProbabilityCount) * 1000) / 1000
}

function computeRootMeanSquare(sampleList: Float32Array): number {
	if (sampleList.length === 0) return 0
	let squareSum = 0
	for (let sampleIndex = 0; sampleIndex < sampleList.length; sampleIndex += 1) {
		const sampleValue = sampleList[sampleIndex] ?? 0
		squareSum += sampleValue * sampleValue
	}
	return Math.sqrt(squareSum / sampleList.length)
}

const manualCommitIntervalMilliseconds = parsePositiveIntegerEnvironmentValue(
	'NEXT_PUBLIC_LILAC_TRANSLATE_COMMIT_INTERVAL_MS',
	780,
	{ maximum: 2_000, minimum: 240 }
)
const minimumCommitAudioDurationMilliseconds = parsePositiveIntegerEnvironmentValue(
	'NEXT_PUBLIC_LILAC_TRANSLATE_MIN_COMMIT_AUDIO_MS',
	280,
	{ maximum: 1_000, minimum: 180 }
)
const minimumForcedCommitAudioDurationMilliseconds = 140
const speechDetectionHangoverMilliseconds = 220
const speechDetectionRootMeanSquareThreshold = parsePositiveFloatEnvironmentValue(
	'NEXT_PUBLIC_LILAC_TRANSLATE_SPEECH_RMS_THRESHOLD',
	0.012,
	{ maximum: 0.08, minimum: 0.004 }
)
const transcriptionSampleRateHertz = 24_000
const shouldEmitVerboseRealtimeLogs = process.env.NEXT_PUBLIC_LILAC_VERBOSE_LOGS === 'true'

function emitSubtitleClientLog(
	level: 'error' | 'info' | 'warn',
	event: string,
	details: Record<string, unknown>
): void {
	if (level === 'info' && !shouldEmitVerboseRealtimeLogs) return
	const payload = {
		...details,
		event,
		scope: 'subtitle_transcription',
		timestamp: new Date().toISOString()
	}
	switch (level) {
		case 'error':
			console.error('[lilac.realtime]', payload)
			return
		case 'warn':
			console.warn('[lilac.realtime]', payload)
			return
		default:
			console.info('[lilac.realtime]', payload)
	}
}

export class SubtitleTranscriptionClient {
	private audioContext: AudioContext | null = null
	private callbacks: SubtitleTranscriptionClientCallbacks
	private committedAudioPcm16ByItemId = new Map<string, Int16Array>()
	private commitTimerId: null | number = null
	private committedAudioDurationMillisecondsByItemId = new Map<string, number>()
	private committedAtByItemId = new Map<string, number>()
	private generation = 0
	private lastCompletedConfidence: number | null = null
	private localAudioStream: MediaStream | null = null
	private micProcessorNode: ScriptProcessorNode | null = null
	private micSourceNode: MediaStreamAudioSourceNode | null = null
	private pendingAudioDurationMilliseconds = 0
	private pendingAudioPcm16ChunkList: Int16Array[] = []
	private pendingCommitAudioPcm16Queue: Int16Array[] = []
	private pendingCommitAudioDurationMillisecondsQueue: number[] = []
	private pendingSpeechHangoverMilliseconds = 0
	private previousItemIdByItemId = new Map<string, null | string>()
	private segmentSequence = 0
	private silentGainNode: GainNode | null = null
	private state: SubtitleTranscriptionClientState = 'disconnected'
	private subtitleSettings: null | SubtitleTranscriptionSettings = null
	private voiceInputEnabled = true
	private websocket: WebSocket | null = null

	public constructor(callbacks: SubtitleTranscriptionClientCallbacks) {
		this.callbacks = callbacks
	}

	public async start(input: StartSubtitleTranscriptionClientInput): Promise<void> {
		this.stop()
		this.generation += 1
		const generation = this.generation
		this.subtitleSettings = {
			myLanguageCode: input.myLanguageCode,
			translateToLanguageCode: input.translateToLanguageCode
		}
		this.voiceInputEnabled = input.voiceInputEnabled
		this.setState('connecting')

		try {
			const clientSecret = await createRealtimeTranscriptionSessionAction({
				asrProfile: resolveAsrProfileFromEnvironment(),
				myLanguageCode: input.myLanguageCode,
				translateToLanguageCode: input.translateToLanguageCode
			})
			if (generation !== this.generation) return

			const websocket = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', [
				'realtime',
				`openai-insecure-api-key.${clientSecret.value}`,
				'openai-beta.realtime-v1'
			])
			this.websocket = websocket

			websocket.addEventListener('open', () => {
				if (generation !== this.generation) return
				this.setState('connected')
				emitSubtitleClientLog('info', 'socket_open', { generation })
				this.sendTranscriptionSessionUpdate()
				if (this.voiceInputEnabled) {
					void this.enableVoiceInput(generation)
				}
			})

			websocket.addEventListener('message', event => {
				this.handleServerEvent(event.data)
			})

			websocket.addEventListener('error', () => {
				if (generation !== this.generation) return
				this.setState('error')
				emitSubtitleClientLog('error', 'socket_error', { generation })
				this.callbacks.onError('Subtitle stream connection error.')
			})

			websocket.addEventListener('close', () => {
				if (generation !== this.generation) return
				this.setState('disconnected')
				emitSubtitleClientLog('warn', 'socket_close', { generation })
				this.callbacks.onListeningStateChange(false)
			})
		} catch (error) {
			if (generation !== this.generation) return
			this.setState('error')
			emitSubtitleClientLog('error', 'start_failed', {
				generation,
				message: error instanceof Error ? error.message : 'unknown'
			})
			const fallbackMessage = 'Unable to start subtitle transcription.'
			if (error instanceof Error) this.callbacks.onError(error.message || fallbackMessage)
			else this.callbacks.onError(fallbackMessage)
			this.stop()
		}
	}

	public stop(): void {
		this.generation += 1
		this.stopVoiceInput()
		this.committedAudioPcm16ByItemId.clear()
		this.committedAudioDurationMillisecondsByItemId.clear()
		this.committedAtByItemId.clear()
		this.lastCompletedConfidence = null
		this.pendingAudioPcm16ChunkList = []
		this.pendingCommitAudioPcm16Queue = []
		this.pendingCommitAudioDurationMillisecondsQueue = []
		this.previousItemIdByItemId.clear()
		this.segmentSequence = 0
		this.subtitleSettings = null

		try {
			this.websocket?.close()
		} catch {}
		this.websocket = null

		this.setState('disconnected')
		this.callbacks.onListeningStateChange(false)
	}

	public isConnected(): boolean {
		return this.state === 'connected'
	}

	public async updateVoiceInputEnabled(voiceInputEnabled: boolean): Promise<void> {
		this.voiceInputEnabled = voiceInputEnabled
		if (!voiceInputEnabled) {
			this.stopVoiceInput()
			this.callbacks.onListeningStateChange(false)
			return
		}
		if (!this.isConnected()) return
		if (this.localAudioStream !== null) return
		const generation = this.generation
		await this.enableVoiceInput(generation)
	}

	public updateSubtitleSettings(settings: SubtitleTranscriptionSettings): void {
		const didLanguageChange =
			this.subtitleSettings?.myLanguageCode !== settings.myLanguageCode ||
			this.subtitleSettings?.translateToLanguageCode !== settings.translateToLanguageCode
		this.subtitleSettings = settings
		if (didLanguageChange) this.lastCompletedConfidence = null
		this.sendTranscriptionSessionUpdate()
	}

	private setState(state: SubtitleTranscriptionClientState): void {
		this.state = state
		this.callbacks.onConnectionStateChange(state)
	}

	private commitAudioBufferIfReady(forceCommit: boolean): void {
		if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return
		const effectiveMinimumCommitAudioDurationMilliseconds =
			typeof this.lastCompletedConfidence === 'number' && this.lastCompletedConfidence < 0.55
				? minimumCommitAudioDurationMilliseconds + 120
				: minimumCommitAudioDurationMilliseconds
		if (
			!forceCommit &&
			this.pendingAudioDurationMilliseconds < effectiveMinimumCommitAudioDurationMilliseconds
		) {
			return
		}
		if (
			forceCommit &&
			this.pendingAudioDurationMilliseconds < minimumForcedCommitAudioDurationMilliseconds
		) {
			this.pendingAudioDurationMilliseconds = 0
			this.pendingAudioPcm16ChunkList = []
			return
		}
		if (this.pendingAudioDurationMilliseconds <= 0) return
		const pendingAudioDurationMilliseconds = Math.round(this.pendingAudioDurationMilliseconds)
		const pendingAudioPcm16Data = concatInt16ArrayList(this.pendingAudioPcm16ChunkList)
		const didSendCommit = this.sendEvent({
			type: 'input_audio_buffer.commit'
		})
		if (!didSendCommit) return
		this.pendingCommitAudioPcm16Queue.push(pendingAudioPcm16Data)
		this.pendingCommitAudioDurationMillisecondsQueue.push(pendingAudioDurationMilliseconds)
		emitSubtitleClientLog('info', 'manual_commit', {
			audioDurationMilliseconds: pendingAudioDurationMilliseconds,
			effectiveMinimumCommitAudioDurationMilliseconds,
			forceCommit
		})
		this.pendingAudioDurationMilliseconds = 0
		this.pendingAudioPcm16ChunkList = []
	}

	private startManualCommitLoop(): void {
		this.stopManualCommitLoop()
		this.commitTimerId = window.setInterval(() => {
			this.commitAudioBufferIfReady(false)
		}, manualCommitIntervalMilliseconds)
	}

	private stopManualCommitLoop(): void {
		if (typeof this.commitTimerId !== 'number') return
		window.clearInterval(this.commitTimerId)
		this.commitTimerId = null
	}

	private async enableVoiceInput(generation: number): Promise<void> {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				autoGainControl: true,
				echoCancellation: true,
				noiseSuppression: true
			}
		})
		if (generation !== this.generation || !this.voiceInputEnabled) {
			for (const track of stream.getTracks()) track.stop()
			return
		}

		const audioContext = new AudioContext()
		this.audioContext = audioContext
		this.localAudioStream = stream
		this.micSourceNode = audioContext.createMediaStreamSource(stream)
		this.micProcessorNode = audioContext.createScriptProcessor(4096, 1, 1)
		this.silentGainNode = audioContext.createGain()
		this.silentGainNode.gain.value = 0

		this.micProcessorNode.onaudioprocess = event => {
			const rawInputBuffer = event.inputBuffer.getChannelData(0)
			if (!rawInputBuffer || rawInputBuffer.length === 0) return
			const pcm16Buffer = convertFloat32ToInt16(
				rawInputBuffer,
				audioContext.sampleRate,
				transcriptionSampleRateHertz
			)
			if (pcm16Buffer.length === 0) return
			const chunkDurationMilliseconds = (pcm16Buffer.length / transcriptionSampleRateHertz) * 1000
			const chunkRootMeanSquare = computeRootMeanSquare(rawInputBuffer)
			const hasSpeechActivity = chunkRootMeanSquare >= speechDetectionRootMeanSquareThreshold
			if (hasSpeechActivity) {
				this.pendingSpeechHangoverMilliseconds = speechDetectionHangoverMilliseconds
			} else {
				this.pendingSpeechHangoverMilliseconds = Math.max(
					0,
					this.pendingSpeechHangoverMilliseconds - chunkDurationMilliseconds
				)
			}
			if (!hasSpeechActivity && this.pendingSpeechHangoverMilliseconds <= 0) return
			const audioBase64 = int16ArrayToBase64(pcm16Buffer)
			if (!audioBase64) return
			const didSendAudioChunk = this.sendEvent({
				audio: audioBase64,
				type: 'input_audio_buffer.append'
			})
			if (!didSendAudioChunk) return
			this.pendingAudioDurationMilliseconds += chunkDurationMilliseconds
			this.pendingAudioPcm16ChunkList.push(pcm16Buffer)
		}

		this.micSourceNode.connect(this.micProcessorNode)
		this.micProcessorNode.connect(this.silentGainNode)
		this.silentGainNode.connect(audioContext.destination)

		this.pendingAudioDurationMilliseconds = 0
		this.pendingSpeechHangoverMilliseconds = 0
		this.startManualCommitLoop()
		this.callbacks.onListeningStateChange(true)
	}

	private stopVoiceInput(): void {
		this.commitAudioBufferIfReady(true)
		this.stopManualCommitLoop()
		if (this.micProcessorNode) {
			this.micProcessorNode.disconnect()
			this.micProcessorNode.onaudioprocess = null
			this.micProcessorNode = null
		}
		if (this.micSourceNode) {
			this.micSourceNode.disconnect()
			this.micSourceNode = null
		}
		if (this.silentGainNode) {
			this.silentGainNode.disconnect()
			this.silentGainNode = null
		}
		if (this.audioContext) {
			void this.audioContext.close().catch(() => {})
			this.audioContext = null
		}
		for (const track of this.localAudioStream?.getTracks() ?? []) {
			track.stop()
		}
		this.localAudioStream = null
		this.pendingAudioDurationMilliseconds = 0
		this.pendingAudioPcm16ChunkList = []
		this.pendingCommitAudioPcm16Queue = []
		this.pendingSpeechHangoverMilliseconds = 0
	}

	private handleInputAudioBufferCommittedEvent(candidate: unknown): void {
		const event = InputAudioBufferCommittedEventSchema.parse(candidate)
		this.previousItemIdByItemId.set(event.item_id, event.previous_item_id ?? null)
		this.committedAtByItemId.set(event.item_id, Date.now())
		const committedAudioDurationMilliseconds =
			this.pendingCommitAudioDurationMillisecondsQueue.shift() ?? undefined
		if (typeof committedAudioDurationMilliseconds === 'number') {
			this.committedAudioDurationMillisecondsByItemId.set(
				event.item_id,
				committedAudioDurationMilliseconds
			)
		}
		const committedAudioPcm16Data = this.pendingCommitAudioPcm16Queue.shift()
		if (committedAudioPcm16Data && committedAudioPcm16Data.length > 0) {
			this.committedAudioPcm16ByItemId.set(event.item_id, committedAudioPcm16Data)
		}
	}

	private handleInputAudioTranscriptionDeltaEvent(candidate: unknown): void {
		const event = InputAudioTranscriptionDeltaEventSchema.parse(candidate)
		if (!event.delta) return
		this.callbacks.onSubtitleDelta({
			itemId: event.item_id,
			previousItemId: this.previousItemIdByItemId.get(event.item_id) ?? null,
			textDelta: event.delta
		})
	}

	private handleInputAudioTranscriptionCompletedEvent(candidate: unknown): void {
		const event = InputAudioTranscriptionCompletedEventSchema.parse(candidate)
		const transcript = normalizeWhitespace(event.transcript)
		if (!transcript) return
		const confidence = computeConfidenceFromLogprobs(event.logprobs)
		const audioDurationMilliseconds = this.committedAudioDurationMillisecondsByItemId.get(
			event.item_id
		)
		this.committedAudioDurationMillisecondsByItemId.delete(event.item_id)
		const audioPcm16Data = this.committedAudioPcm16ByItemId.get(event.item_id)
		this.committedAudioPcm16ByItemId.delete(event.item_id)
		if (
			shouldDropLowSignalTranscript({
				audioDurationMilliseconds,
				confidence,
				transcript
			})
		) {
			emitSubtitleClientLog('info', 'drop_low_signal_transcript', {
				audioDurationMilliseconds,
				confidence,
				itemId: event.item_id,
				transcript
			})
			return
		}
		this.segmentSequence += 1
		this.lastCompletedConfidence = typeof confidence === 'number' ? confidence : null
		this.callbacks.onSubtitleFinal({
			...(audioPcm16Data ? { audioPcm16Data } : {}),
			committedAt: this.committedAtByItemId.get(event.item_id) ?? Date.now(),
			itemId: event.item_id,
			previousItemId: this.previousItemIdByItemId.get(event.item_id) ?? null,
			segmentSequence: this.segmentSequence,
			text: transcript,
			...(typeof confidence === 'number' ? { confidence } : {})
		})
	}

	private sendTranscriptionSessionUpdate(): void {
		if (!this.subtitleSettings) return
		this.sendEvent({
			session: createTranscriptionSessionPatch({
				settings: this.subtitleSettings
			}),
			type: 'transcription_session.update'
		})
	}

	private handleServerEvent(rawData: unknown): void {
		try {
			const candidate = typeof rawData === 'string' ? JSON.parse(rawData) : rawData
			const baseEvent = RealtimeBaseServerEventSchema.parse(candidate)

			switch (baseEvent.type) {
				case 'input_audio_buffer.committed': {
					this.handleInputAudioBufferCommittedEvent(candidate)
					return
				}
				case 'input_audio_buffer.speech_started': {
					InputAudioBufferSpeechStartedEventSchema.parse(candidate)
					this.callbacks.onListeningStateChange(true)
					return
				}
				case 'input_audio_buffer.speech_stopped': {
					InputAudioBufferSpeechStoppedEventSchema.parse(candidate)
					this.callbacks.onListeningStateChange(false)
					return
				}
				case 'conversation.item.input_audio_transcription.delta': {
					this.handleInputAudioTranscriptionDeltaEvent(candidate)
					return
				}
				case 'conversation.item.input_audio_transcription.completed': {
					this.handleInputAudioTranscriptionCompletedEvent(candidate)
					return
				}
				case 'error': {
					const event = RealtimeErrorEventSchema.parse(candidate)
					emitSubtitleClientLog('error', 'realtime_error', {
						message: event.error?.message || 'Subtitle transcription error.'
					})
					this.callbacks.onError(event.error?.message || 'Subtitle transcription error.')
					return
				}
				default:
					return
			}
		} catch {
			return
		}
	}

	private sendEvent(event: Record<string, unknown>): boolean {
		if (!this.websocket) return false
		if (this.websocket.readyState !== WebSocket.OPEN) return false
		try {
			this.websocket.send(JSON.stringify(event))
			return true
		} catch {}
		return false
	}
}
