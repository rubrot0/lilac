'use client'

import { createTranslateRealtimeClientSecretAction } from '@/app/actions/realtime'
import {
	PublishTranslationToolArgumentsSchema,
	RealtimeBaseServerEventSchema,
	RealtimeErrorEventSchema,
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
	retryCount: number
	sourceText: string
}

const translationResponseTimeoutMilliseconds = 16_000
const maxMissingToolCallRetryCount = 1

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
	private callbacks: LiveTranslateRealtimeClientCallbacks
	private completedToolArgumentsByResponseId = new Map<string, string>()
	private dataChannel: null | RTCDataChannel = null
	private generation = 0
	private pendingRequestIdQueue: string[] = []
	private pendingResponseContextByRequestId = new Map<string, PendingResponseContext>()
	private pendingResponseTimeoutByRequestId = new Map<string, number>()
	private peerConnection: null | RTCPeerConnection = null
	private sourceItemOrder: string[] = []
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

			const dataChannel = peerConnection.createDataChannel('oai-events')
			this.dataChannel = dataChannel

			dataChannel.addEventListener('open', () => {
				if (generation !== this.generation) return
				this.setState('connected')
				this.updateTranslateSettings({
					myLanguageCode: input.myLanguageCode,
					translateToLanguageCode: input.translateToLanguageCode
				})
			})

			dataChannel.addEventListener('close', () => {
				if (generation !== this.generation) return
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
		this.completedToolArgumentsByResponseId.clear()
		this.pendingResponseTimeoutByRequestId.forEach(timeoutId => {
			window.clearTimeout(timeoutId)
		})
		this.pendingResponseTimeoutByRequestId.clear()
		this.pendingRequestIdQueue = []
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
		this.setState('disconnected')
	}

	public isConnected(): boolean {
		return this.state === 'connected'
	}

	public submitInput(input: TranslateInputPayload): void {
		const normalizedText = input.text.trim()
		if (!normalizedText) return
		this.registerSourceItem(input.itemId)
		this.sendEvent({
			item: {
				content: [
					{
						text: normalizedText,
						type: 'input_text'
					}
				],
				id: input.itemId,
				role: 'user',
				type: 'message'
			},
			type: 'conversation.item.create'
		})
		this.requestTranslationResponse(input.itemId, input.inputOrigin, normalizedText)
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

	private buildResponseInput(itemId: string): Array<Record<string, string>> {
		const recentItemIdList = this.sourceItemOrder.slice(Math.max(0, this.sourceItemOrder.length - 12))
		if (!recentItemIdList.includes(itemId)) recentItemIdList.push(itemId)
		return recentItemIdList.map(sourceItemId => ({
			id: sourceItemId,
			type: 'item_reference'
		}))
	}

	private setState(state: LiveTranslateRealtimeClientState): void {
		this.state = state
		this.callbacks.onConnectionStateChange(state)
	}

	private handleResponseDoneEvent(event: ReturnType<typeof ResponseDoneEventSchema.parse>): void {
		const response = event.response
		if (!response) return
		const responseStatus = parseStringValue(response.status)?.toLowerCase() ?? null

		const metadata = response.metadata ?? {}
		const requestId = parseStringValue(metadata.request_id)
		const sourceItemIdFromMetadata = parseStringValue(metadata.source_item_id)
		const inputOriginFromMetadata = parseStringValue(metadata.input_origin)

		const pendingContext = this.resolvePendingContext(requestId)
		const sourceItemId = sourceItemIdFromMetadata ?? pendingContext?.itemId ?? null
		const rawInputOrigin = inputOriginFromMetadata ?? pendingContext?.inputOrigin ?? null
		const inputOrigin: 'audio' | 'text' = rawInputOrigin === 'text' ? 'text' : 'audio'
		if (!sourceItemId) return

		const functionCall = (response.output ?? []).find(
			item => item.type === 'function_call' && item.name === 'publish_translation'
		)
		const responseId = response.id
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
			if (pendingContext && pendingContext.retryCount < maxMissingToolCallRetryCount) {
				this.requestTranslationResponse(
					pendingContext.itemId,
					pendingContext.inputOrigin,
					pendingContext.sourceText,
					pendingContext.retryCount + 1
				)
				return
			}
			this.callbacks.onResultPatch({
				direction: 'my_to_target',
				inputOrigin,
				itemId: sourceItemId,
				sourceLanguageCode: 'und',
				sourceText: pendingContext?.sourceText ?? '',
				status: 'error',
				targetLanguageCode: 'und',
				translatedText: responseStatus
					? `No valid publish_translation tool call was returned (${responseStatus}).`
					: 'No valid publish_translation tool call was returned.',
				...(responseId ? { responseId } : {})
			})
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
			this.callbacks.onResultPatch({
				direction: 'my_to_target',
				inputOrigin,
				itemId: sourceItemId,
				sourceLanguageCode: 'und',
				sourceText: pendingContext?.sourceText ?? '',
				status: 'error',
				targetLanguageCode: 'und',
				translatedText: 'Tool arguments were malformed and could not be parsed.',
				...(responseId ? { responseId } : {})
			})
		}
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
					this.callbacks.onError(event.error?.message || 'Realtime session error')
					return
				}
				default:
					return
			}
		} catch {
			return
		}
	}

	private registerSourceItem(itemId: string): void {
		if (this.sourceItemOrder.includes(itemId)) return
		this.sourceItemOrder.push(itemId)
		if (this.sourceItemOrder.length > 64) {
			this.sourceItemOrder = this.sourceItemOrder.slice(this.sourceItemOrder.length - 64)
		}
	}

	private clearPendingRequestTimeout(requestId: string): void {
		const timeoutId = this.pendingResponseTimeoutByRequestId.get(requestId)
		if (typeof timeoutId === 'number') {
			window.clearTimeout(timeoutId)
		}
		this.pendingResponseTimeoutByRequestId.delete(requestId)
	}

	private removePendingRequestIdFromQueue(requestId: string): void {
		const requestIndex = this.pendingRequestIdQueue.indexOf(requestId)
		if (requestIndex === -1) return
		this.pendingRequestIdQueue.splice(requestIndex, 1)
	}

	private resolvePendingContext(requestId: null | string): null | PendingResponseContext {
		if (requestId) {
			const directContext = this.pendingResponseContextByRequestId.get(requestId) ?? null
			this.pendingResponseContextByRequestId.delete(requestId)
			this.clearPendingRequestTimeout(requestId)
			this.removePendingRequestIdFromQueue(requestId)
			if (directContext) return directContext
		}

		const fallbackRequestId = this.pendingRequestIdQueue.shift()
		if (!fallbackRequestId) return null
		const fallbackContext = this.pendingResponseContextByRequestId.get(fallbackRequestId) ?? null
		this.pendingResponseContextByRequestId.delete(fallbackRequestId)
		this.clearPendingRequestTimeout(fallbackRequestId)
		return fallbackContext
	}

	private requestTranslationResponse(
		itemId: string,
		inputOrigin: 'audio' | 'text',
		sourceText: string,
		retryCount = 0
	): void {
		const requestId = crypto.randomUUID()
		this.pendingResponseContextByRequestId.set(requestId, {
			inputOrigin,
			itemId,
			retryCount,
			sourceText
		})
		this.pendingRequestIdQueue.push(requestId)
		const timeoutId = window.setTimeout(() => {
			const pendingContext = this.pendingResponseContextByRequestId.get(requestId)
			if (!pendingContext) return
			this.pendingResponseContextByRequestId.delete(requestId)
			this.removePendingRequestIdFromQueue(requestId)
			this.clearPendingRequestTimeout(requestId)

			if (pendingContext.retryCount < maxMissingToolCallRetryCount) {
				this.requestTranslationResponse(
					pendingContext.itemId,
					pendingContext.inputOrigin,
					pendingContext.sourceText,
					pendingContext.retryCount + 1
				)
				return
			}

			this.callbacks.onResultPatch({
				direction: 'my_to_target',
				inputOrigin: pendingContext.inputOrigin,
				itemId: pendingContext.itemId,
				sourceLanguageCode: 'und',
				sourceText: pendingContext.sourceText,
				status: 'error',
				targetLanguageCode: 'und',
				translatedText: 'Translation timed out before tool output was returned.'
			})
		}, translationResponseTimeoutMilliseconds)
		this.pendingResponseTimeoutByRequestId.set(requestId, timeoutId)
		this.sendEvent({
			response: {
				conversation: 'none',
				input: this.buildResponseInput(itemId),
				instructions:
					'Translate the referenced user item and call publish_translation exactly once. Do not return plain assistant text.',
				metadata: {
					input_origin: inputOrigin,
					request_id: requestId,
					retry_count: retryCount,
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
