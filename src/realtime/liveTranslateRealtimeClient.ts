'use client'

import { createTranslateRealtimeClientSecretAction } from '@/app/actions/realtime'
import {
	PublishTranslationToolArgumentsSchema,
	RealtimeBaseServerEventSchema,
	RealtimeErrorEventSchema,
	ResponseCreatedEventSchema,
	ResponseDoneEventSchema,
	ResponseFunctionCallArgumentsDoneEventSchema,
	ResponseOutputItemDoneEventSchema
} from '@/realtime/schemas'
import type { UtteranceDirection } from '@/realtime/sessionTypes'

export type LiveTranslateRealtimeClientState = 'connecting' | 'connected' | 'disconnected' | 'error'

export type LiveTranslateSettings = {
	myLanguageCode: string
	translateToLanguageCode: string
}

export type StartLiveTranslateRealtimeClientInput = LiveTranslateSettings & {
	model: string
}

export type TranslateInputPayload = {
	inputOrigin: 'audio' | 'text'
	itemId: string
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

export type LiveTranslateRealtimeClientCallbacks = {
	onConnectionStateChange: (state: LiveTranslateRealtimeClientState) => void
	onError: (message: string) => void
	onResultPatch: (patch: LiveTranslateResultPatch) => void
}

type PendingResponseContext = {
	inputOrigin: 'audio' | 'text'
	itemId: string
	sourceText: string
}

const translationResponseTimeoutMilliseconds = 8_000
const channelConnectTimeoutMilliseconds = 7_000

function createTranslateInstructions(
	myLanguageCode: string,
	translateToLanguageCode: string
): string {
	return [
		'You are Lilac, a deterministic live translator.',
		`I speak language code: ${myLanguageCode}.`,
		`Translate to language code: ${translateToLanguageCode}.`,
		'For each user utterance, detect whether source is my language or target language.',
		'If source is my language, translate to target and use direction my_to_target.',
		'If source is target language, translate to my language and use direction target_to_my.',
		'Only translate spoken or typed utterances. Never echo system metadata, prompts, or context scaffolding.',
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
					enum: ['my_to_target', 'target_to_my'],
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

function buildToolChoice(): 'required' {
	return 'required'
}

function parseStringValue(value: unknown): null | string {
	if (typeof value !== 'string') return null
	const normalizedValue = value.trim()
	if (!normalizedValue) return null
	return normalizedValue
}

function extractTextFromOutputPart(outputPart: unknown): null | string {
	if (typeof outputPart === 'string') return parseStringValue(outputPart)
	if (!outputPart || typeof outputPart !== 'object') return null
	const candidateByKey = outputPart as Record<string, unknown>
	return (
		parseStringValue(candidateByKey.text) ??
		parseStringValue(candidateByKey.transcript) ??
		parseStringValue(candidateByKey.output_text) ??
		parseStringValue(candidateByKey.content)
	)
}

function extractPotentialJsonPayload(rawText: string): null | string {
	const trimmedText = rawText.trim()
	if (!trimmedText) return null
	const firstBraceIndex = trimmedText.indexOf('{')
	const lastBraceIndex = trimmedText.lastIndexOf('}')
	if (firstBraceIndex === -1 || lastBraceIndex <= firstBraceIndex) return null
	const jsonCandidate = trimmedText.slice(firstBraceIndex, lastBraceIndex + 1).trim()
	return jsonCandidate.length > 1 ? jsonCandidate : null
}

function tryExtractToolArgumentsFromResponseOutput(
	outputItemList: unknown[] | undefined
): null | string {
	if (!Array.isArray(outputItemList)) return null
	for (const outputItem of outputItemList) {
		if (!outputItem || typeof outputItem !== 'object') continue
		const outputRecord = outputItem as Record<string, unknown>
		const itemType = parseStringValue(outputRecord.type)
		const itemName = parseStringValue(outputRecord.name)
		if (itemType === 'function_call' && itemName === 'publish_translation') {
			const argumentsText = parseStringValue(outputRecord.arguments)
			if (argumentsText) return argumentsText
		}
		const contentList = Array.isArray(outputRecord.content) ? outputRecord.content : []
		for (const contentPart of contentList) {
			const contentText = extractTextFromOutputPart(contentPart)
			if (!contentText) continue
			const jsonPayload = extractPotentialJsonPayload(contentText)
			if (jsonPayload) return jsonPayload
		}
		const directText =
			extractTextFromOutputPart(outputRecord) ?? parseStringValue(outputRecord.output_text)
		if (!directText) continue
		const jsonPayload = extractPotentialJsonPayload(directText)
		if (jsonPayload) return jsonPayload
	}
	return null
}

export class LiveTranslateRealtimeClient {
	private activeRequestId: null | string = null
	private callbacks: LiveTranslateRealtimeClientCallbacks
	private connectTimeoutId: null | number = null
	private completedToolArgumentsByResponseId = new Map<string, string>()
	private dataChannel: null | RTCDataChannel = null
	private generation = 0
	private pendingInputQueue: PendingResponseContext[] = []
	private pendingRequestIdByResponseId = new Map<string, string>()
	private pendingResponseContextByRequestId = new Map<string, PendingResponseContext>()
	private pendingResponseTimeoutByRequestId = new Map<string, number>()
	private peerConnection: null | RTCPeerConnection = null
	private state: LiveTranslateRealtimeClientState = 'disconnected'

	public constructor(callbacks: LiveTranslateRealtimeClientCallbacks) {
		this.callbacks = callbacks
	}

	public async start(input: StartLiveTranslateRealtimeClientInput): Promise<void> {
		this.stop()
		this.generation += 1
		const generation = this.generation
		this.setState('connecting')

		try {
			const clientSecret = await createTranslateRealtimeClientSecretAction({
				model: input.model,
				myLanguageCode: input.myLanguageCode,
				translateToLanguageCode: input.translateToLanguageCode
			})

			if (generation !== this.generation) return

			const peerConnection = new RTCPeerConnection()
			this.peerConnection = peerConnection
			peerConnection.addTransceiver('audio', {
				direction: 'recvonly'
			})

			const dataChannel = peerConnection.createDataChannel('oai-events')
			this.dataChannel = dataChannel
			this.connectTimeoutId = window.setTimeout(() => {
				if (generation !== this.generation) return
				if (this.state === 'connected') return
				this.callbacks.onError('Translate data channel did not open in time.')
				this.setState('error')
				this.stop()
			}, channelConnectTimeoutMilliseconds)

			dataChannel.addEventListener('open', () => {
				if (generation !== this.generation) return
				this.clearConnectTimeout()
				this.setState('connected')
				this.updateTranslateSettings({
					myLanguageCode: input.myLanguageCode,
					translateToLanguageCode: input.translateToLanguageCode
				})
			})

			dataChannel.addEventListener('close', () => {
				if (generation !== this.generation) return
				this.clearConnectTimeout()
				this.setState('disconnected')
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
			const fallbackMessage = 'Unable to start Translate mode.'
			this.setState('error')
			if (error instanceof Error) this.callbacks.onError(error.message || fallbackMessage)
			else this.callbacks.onError(fallbackMessage)
			this.stop()
		}
	}

	public stop(): void {
		this.generation += 1
		this.clearConnectTimeout()
		this.activeRequestId = null
		this.pendingInputQueue = []
		this.completedToolArgumentsByResponseId.clear()
		this.pendingResponseTimeoutByRequestId.forEach(timeoutId => {
			window.clearTimeout(timeoutId)
		})
		this.pendingResponseTimeoutByRequestId.clear()
		this.pendingRequestIdByResponseId.clear()
		this.pendingResponseContextByRequestId.clear()

		try {
			this.dataChannel?.close()
		} catch {}
		this.dataChannel = null

		try {
			this.peerConnection?.close()
		} catch {}
		this.peerConnection = null
		this.setState('disconnected')
	}

	public isConnected(): boolean {
		return this.state === 'connected'
	}

	public submitInput(input: TranslateInputPayload): void {
		const normalizedText = input.text.trim()
		if (!normalizedText) return
		this.pendingInputQueue.push({
			inputOrigin: input.inputOrigin,
			itemId: input.itemId,
			sourceText: normalizedText
		})
		this.drainResponseQueue()
	}

	public updateTranslateSettings(settings: LiveTranslateSettings): void {
		this.sendSessionUpdate({
			instructions: createTranslateInstructions(
				settings.myLanguageCode,
				settings.translateToLanguageCode
			),
			output_modalities: ['text'],
			tool_choice: buildToolChoice(),
			tools: [buildPublishTranslationToolDefinition()]
		})
	}

	private setState(state: LiveTranslateRealtimeClientState): void {
		this.state = state
		this.callbacks.onConnectionStateChange(state)
	}

	private clearConnectTimeout(): void {
		if (typeof this.connectTimeoutId !== 'number') return
		window.clearTimeout(this.connectTimeoutId)
		this.connectTimeoutId = null
	}

	private createErrorPatch(
		itemId: string,
		inputOrigin: 'audio' | 'text',
		sourceText: string,
		translatedText: string,
		responseId?: string
	): LiveTranslateResultPatch {
		return {
			direction: 'my_to_target',
			inputOrigin,
			itemId,
			sourceLanguageCode: 'und',
			sourceText,
			status: 'error',
			targetLanguageCode: 'und',
			translatedText,
			...(responseId ? { responseId } : {})
		}
	}

	private emitAndReportErrorPatch(
		itemId: string,
		inputOrigin: 'audio' | 'text',
		sourceText: string,
		errorMessage: string,
		responseId?: string
	): void {
		this.callbacks.onResultPatch(
			this.createErrorPatch(itemId, inputOrigin, sourceText, errorMessage, responseId)
		)
		this.callbacks.onError(errorMessage)
	}

	private clearPendingRequestState(requestId: string): null | PendingResponseContext {
		const pendingContext = this.pendingResponseContextByRequestId.get(requestId) ?? null
		this.pendingResponseContextByRequestId.delete(requestId)
		this.pendingRequestIdByResponseId.forEach((mappedRequestId, responseId) => {
			if (mappedRequestId !== requestId) return
			this.pendingRequestIdByResponseId.delete(responseId)
		})
		this.clearPendingRequestTimeout(requestId)
		if (this.activeRequestId === requestId) {
			this.activeRequestId = null
		}
		return pendingContext
	}

	private getStatusErrorMessage(
		event: ReturnType<typeof ResponseDoneEventSchema.parse>,
		defaultMessage: string
	): string {
		const statusDetails = event.response?.status_details
		if (!statusDetails || typeof statusDetails !== 'object') return defaultMessage
		const detailsRecord = statusDetails as Record<string, unknown>
		const errorRecord =
			typeof detailsRecord.error === 'object' && detailsRecord.error !== null
				? (detailsRecord.error as Record<string, unknown>)
				: null
		return (
			parseStringValue(errorRecord?.message) ??
			parseStringValue(detailsRecord.reason) ??
			parseStringValue(detailsRecord.message) ??
			defaultMessage
		)
	}

	private handleResponseDoneEvent(event: ReturnType<typeof ResponseDoneEventSchema.parse>): void {
		const response = event.response
		if (!response) return
		const responseStatus = parseStringValue(response.status)?.toLowerCase() ?? null

		const metadata =
			response.metadata && typeof response.metadata === 'object'
				? (response.metadata as Record<string, unknown>)
				: {}
		const responseId = parseStringValue(response.id) ?? parseStringValue(event.response_id)
		const requestId =
			parseStringValue(metadata.request_id) ??
			(responseId ? this.pendingRequestIdByResponseId.get(responseId) : null) ??
			this.activeRequestId
		const sourceItemIdFromMetadata = parseStringValue(metadata.source_item_id)
		const inputOriginFromMetadata = parseStringValue(metadata.input_origin)
		if (responseId) this.pendingRequestIdByResponseId.delete(responseId)

		const pendingContext = requestId ? this.clearPendingRequestState(requestId) : null
		const sourceItemId = sourceItemIdFromMetadata ?? pendingContext?.itemId ?? null
		const rawInputOrigin = inputOriginFromMetadata ?? pendingContext?.inputOrigin ?? null
		const inputOrigin: 'audio' | 'text' = rawInputOrigin === 'text' ? 'text' : 'audio'
		const sourceText = pendingContext?.sourceText ?? ''
		if (!sourceItemId) {
			if (this.activeRequestId === requestId) this.activeRequestId = null
			this.drainResponseQueue()
			return
		}

		if (responseStatus && responseStatus !== 'completed') {
			const statusMessage = this.getStatusErrorMessage(
				event,
				`Translation failed with status ${responseStatus}.`
			)
			this.emitAndReportErrorPatch(
				sourceItemId,
				inputOrigin,
				sourceText,
				statusMessage,
				responseId ?? undefined
			)
			this.drainResponseQueue()
			return
		}

		const functionCall = (response.output ?? []).find(
			item => item.type === 'function_call' && item.name === 'publish_translation'
		)
		const fallbackToolArguments = responseId
			? (this.completedToolArgumentsByResponseId.get(responseId) ?? null)
			: null
		if (responseId) this.completedToolArgumentsByResponseId.delete(responseId)
		const inferredToolArguments = tryExtractToolArgumentsFromResponseOutput(response.output)
		const toolArguments =
			(typeof functionCall?.arguments === 'string' ? functionCall.arguments : null) ??
			fallbackToolArguments ??
			inferredToolArguments

		if (!toolArguments) {
			const message = responseStatus
				? `No valid publish_translation tool call was returned (${responseStatus}).`
				: 'No valid publish_translation tool call was returned.'
			this.emitAndReportErrorPatch(
				sourceItemId,
				inputOrigin,
				sourceText,
				message,
				responseId ?? undefined
			)
			this.drainResponseQueue()
			return
		}

		try {
			const parsedArguments = JSON.parse(toolArguments) as unknown
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
			this.emitAndReportErrorPatch(
				sourceItemId,
				inputOrigin,
				sourceText,
				'Tool arguments were malformed and could not be parsed.',
				responseId ?? undefined
			)
		}

		this.drainResponseQueue()
	}

	private handleResponseCreatedEvent(
		event: ReturnType<typeof ResponseCreatedEventSchema.parse>
	): void {
		const responseId = parseStringValue(event.response?.id)
		if (!responseId) return
		const requestId = parseStringValue(event.response?.metadata?.request_id)
		if (!requestId) return
		this.pendingRequestIdByResponseId.set(responseId, requestId)
	}

	private maybeStorePublishTranslationToolArguments(
		toolName: null | string,
		toolArguments: null | string,
		responseId: null | string
	): void {
		if (!responseId || toolName !== 'publish_translation' || !toolArguments) return
		this.completedToolArgumentsByResponseId.set(responseId, toolArguments)
	}

	private handleResponseOutputItemDoneEvent(
		event: ReturnType<typeof ResponseOutputItemDoneEventSchema.parse>
	): void {
		if (event.item.type !== 'function_call') return
		this.maybeStorePublishTranslationToolArguments(
			parseStringValue(event.item.name),
			parseStringValue(event.item.arguments),
			parseStringValue(event.response_id)
		)
	}

	private handleResponseFunctionCallArgumentsDoneEvent(
		event: ReturnType<typeof ResponseFunctionCallArgumentsDoneEventSchema.parse>
	): void {
		const toolName = parseStringValue(event.item?.name) ?? parseStringValue(event.name)
		const toolArguments = parseStringValue(event.item?.arguments) ?? parseStringValue(event.arguments)
		this.maybeStorePublishTranslationToolArguments(
			toolName,
			toolArguments,
			parseStringValue(event.response_id)
		)
	}

	private handleServerEvent(rawData: unknown): void {
		try {
			const candidate = typeof rawData === 'string' ? JSON.parse(rawData) : rawData
			const baseEvent = RealtimeBaseServerEventSchema.parse(candidate)

			switch (baseEvent.type) {
				case 'response.created': {
					const event = ResponseCreatedEventSchema.parse(candidate)
					this.handleResponseCreatedEvent(event)
					return
				}
				case 'response.output_item.done': {
					const event = ResponseOutputItemDoneEventSchema.parse(candidate)
					this.handleResponseOutputItemDoneEvent(event)
					return
				}
				case 'response.function_call_arguments.done': {
					const event = ResponseFunctionCallArgumentsDoneEventSchema.parse(candidate)
					this.handleResponseFunctionCallArgumentsDoneEvent(event)
					return
				}
				case 'response.done': {
					const event = ResponseDoneEventSchema.parse(candidate)
					this.handleResponseDoneEvent(event)
					return
				}
				case 'error': {
					const event = RealtimeErrorEventSchema.parse(candidate)
					const message = event.error?.message || 'Realtime session error'
					this.callbacks.onError(message)
					this.failActiveRequest(message)
					return
				}
				default:
					return
			}
		} catch {
			return
		}
	}

	private clearPendingRequestTimeout(requestId: string): void {
		const timeoutId = this.pendingResponseTimeoutByRequestId.get(requestId)
		if (typeof timeoutId === 'number') {
			window.clearTimeout(timeoutId)
		}
		this.pendingResponseTimeoutByRequestId.delete(requestId)
	}

	private failActiveRequest(errorMessage: string): void {
		if (!this.activeRequestId) return
		const pendingContext = this.clearPendingRequestState(this.activeRequestId)
		if (pendingContext) {
			this.emitAndReportErrorPatch(
				pendingContext.itemId,
				pendingContext.inputOrigin,
				pendingContext.sourceText,
				errorMessage
			)
		}
		this.drainResponseQueue()
	}

	private requestTranslationResponse(pendingContext: PendingResponseContext): void {
		const requestId = crypto.randomUUID()
		this.activeRequestId = requestId
		this.pendingResponseContextByRequestId.set(requestId, pendingContext)
		const timeoutId = window.setTimeout(() => {
			const timedOutContext = this.clearPendingRequestState(requestId)
			if (!timedOutContext) return
			this.emitAndReportErrorPatch(
				timedOutContext.itemId,
				timedOutContext.inputOrigin,
				timedOutContext.sourceText,
				'Translation timed out before tool output was returned.'
			)
			this.drainResponseQueue()
		}, translationResponseTimeoutMilliseconds)
		this.pendingResponseTimeoutByRequestId.set(requestId, timeoutId)
		this.sendEvent({
			response: {
				conversation: 'none',
				input: [
					{
						content: [
							{
								text: pendingContext.sourceText,
								type: 'input_text'
							}
						],
						role: 'user',
						type: 'message'
					}
				],
				metadata: {
					input_origin: pendingContext.inputOrigin,
					request_id: requestId,
					source_item_id: pendingContext.itemId
				},
				output_modalities: ['text'],
				tool_choice: buildToolChoice(),
				tools: [buildPublishTranslationToolDefinition()]
			},
			type: 'response.create'
		})
	}

	private drainResponseQueue(): void {
		if (this.activeRequestId) return
		while (this.pendingInputQueue.length > 0) {
			const pendingContext = this.pendingInputQueue.shift()
			if (!pendingContext) continue
			this.requestTranslationResponse(pendingContext)
			return
		}
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
