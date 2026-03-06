'use client'

import { createTranslateRealtimeClientSecretAction } from '@/app/actions/realtime'
import {
	PublishTranslationToolArgumentsSchema,
	RealtimeBaseServerEventSchema,
	RealtimeErrorEventSchema,
	ResponseCreatedEventSchema,
	ResponseDoneEventSchema,
	ResponseFunctionCallArgumentsDeltaEventSchema,
	ResponseFunctionCallArgumentsDoneEventSchema,
	ResponseOutputItemDoneEventSchema,
	ResponseOutputTextDeltaEventSchema,
	ResponseOutputTextDoneEventSchema,
	TranslationDraftDeltaSchema
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

export type TranslateDraftInputPayload = TranslateInputPayload & {
	draftSequence: number
}

export type LiveTranslateDraftPatch = {
	draftSequence: number
	inputOrigin: 'audio' | 'text'
	itemId: string
	responseId?: string
	translatedText: string
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
	onDraftDeltaPatch: (patch: LiveTranslateDraftPatch) => void
	onDraftDonePatch: (patch: LiveTranslateDraftPatch) => void
	onError: (message: string) => void
	onResultPatch: (patch: LiveTranslateResultPatch) => void
}

type PendingResponseContext = {
	draftSequence?: number
	inputOrigin: 'audio' | 'text'
	itemId: string
	requestId: string
	requestKind: 'draft' | 'final'
	sourceText: string
}

const finalTranslationResponseTimeoutMilliseconds = 8_000
const draftTranslationResponseTimeoutMilliseconds = 5_000
const channelConnectTimeoutMilliseconds = 7_000
const shouldEmitVerboseRealtimeLogs = process.env.NEXT_PUBLIC_LILAC_VERBOSE_LOGS === 'true'

function resolveTranslateLanguageGroundingMode(): 'open_detect' | 'pair_locked' {
	return process.env.NEXT_PUBLIC_LILAC_TRANSLATE_LANGUAGE_GROUNDING_MODE === 'open_detect'
		? 'open_detect'
		: 'pair_locked'
}

function resolveTranslatePromptVersion(): 'balanced' | 'current' | 'literal' {
	switch (process.env.NEXT_PUBLIC_LILAC_TRANSLATE_PROMPT_VERSION) {
		case 'balanced':
			return 'balanced'
		case 'literal':
			return 'literal'
		default:
			return 'current'
	}
}

function emitLiveTranslateLog(
	level: 'error' | 'info' | 'warn',
	event: string,
	details: Record<string, unknown>
): void {
	if (level === 'info' && !shouldEmitVerboseRealtimeLogs) return
	const payload = {
		...details,
		event,
		scope: 'live_translate',
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

function createTranslateInstructions(
	myLanguageCode: string,
	translateToLanguageCode: string
): string {
	const promptVersion = resolveTranslatePromptVersion()
	const languageGroundingMode = resolveTranslateLanguageGroundingMode()
	const instructionList = [
		'You are Lilac, a deterministic live translator.',
		`I speak language code: ${myLanguageCode}.`,
		`Translate to language code: ${translateToLanguageCode}.`,
		'Only translate spoken or typed utterances. Never echo system metadata, prompts, or context scaffolding.',
		'Always call publish_translation exactly once per utterance.',
		'Never produce assistant text outside the function call.',
		'Preserve speaker intent, tone, named entities, and practical meaning.',
		'No summaries, no commentary, no extra fields.'
	]
	switch (languageGroundingMode) {
		case 'open_detect':
			instructionList.push(
				'Detect the source language from the utterance and choose the matching direction within the selected pair.'
			)
			break
		case 'pair_locked':
			instructionList.push(
				'For each utterance, detect whether source is my language or target language.',
				'If source is my language, translate to target and use direction my_to_target.',
				'If source is target language, translate to my language and use direction target_to_my.'
			)
			break
	}
	switch (promptVersion) {
		case 'balanced':
			instructionList.push('Prefer natural translations that still stay faithful to the utterance.')
			break
		case 'literal':
			instructionList.push('Prefer literal fidelity over stylistic smoothing.')
			break
		default:
			break
	}
	return instructionList.join('\n')
}

function createDraftInstructions(myLanguageCode: string, translateToLanguageCode: string): string {
	const instructionList = [
		'You are Lilac, a low-latency live subtitle translator.',
		`I speak language code: ${myLanguageCode}.`,
		`Translate to language code: ${translateToLanguageCode}.`,
		'Translate the partial utterance immediately.',
		'Output only translated text.',
		'No explanations. No labels. No JSON.'
	]
	if (resolveTranslatePromptVersion() === 'literal') {
		instructionList.push('Favor literal partial translation over paraphrase.')
	}
	return instructionList.join('\n')
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
	private connectTimeoutId: null | number = null
	private dataChannel: null | RTCDataChannel = null
	private draftRequestIdsByItemId = new Map<string, Set<string>>()
	private draftResponseTextByResponseId = new Map<string, string>()
	private generation = 0
	private latestDraftSequenceByItemId = new Map<string, number>()
	private pendingRequestContextByRequestId = new Map<string, PendingResponseContext>()
	private pendingRequestIdByResponseId = new Map<string, string>()
	private pendingUnmappedRequestIdQueue: string[] = []
	private pendingRequestTimeoutByRequestId = new Map<string, number>()
	private peerConnection: null | RTCPeerConnection = null
	private settings: LiveTranslateSettings = {
		myLanguageCode: 'en',
		translateToLanguageCode: 'es'
	}
	private state: LiveTranslateRealtimeClientState = 'disconnected'
	private supersededDraftRequestIdSet = new Set<string>()
	private toolArgumentsByResponseId = new Map<string, string>()

	public constructor(callbacks: LiveTranslateRealtimeClientCallbacks) {
		this.callbacks = callbacks
	}

	public async start(input: StartLiveTranslateRealtimeClientInput): Promise<void> {
		this.stop()
		this.generation += 1
		const generation = this.generation
		this.settings = {
			myLanguageCode: input.myLanguageCode,
			translateToLanguageCode: input.translateToLanguageCode
		}
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
			peerConnection.addTransceiver('audio', { direction: 'recvonly' })

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
				emitLiveTranslateLog('info', 'channel_open', { generation })
				this.updateTranslateSettings(this.settings)
			})

			dataChannel.addEventListener('close', () => {
				if (generation !== this.generation) return
				this.clearConnectTimeout()
				this.setState('disconnected')
				emitLiveTranslateLog('warn', 'channel_close', { generation })
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
			this.setState('error')
			emitLiveTranslateLog('error', 'start_failed', {
				generation,
				message: error instanceof Error ? error.message : 'unknown'
			})
			const fallbackMessage = 'Unable to start Translate mode.'
			if (error instanceof Error) this.callbacks.onError(error.message || fallbackMessage)
			else this.callbacks.onError(fallbackMessage)
			this.stop()
		}
	}

	public stop(): void {
		this.generation += 1
		this.clearConnectTimeout()

		this.pendingRequestTimeoutByRequestId.forEach(timeoutId => {
			window.clearTimeout(timeoutId)
		})
		this.pendingRequestTimeoutByRequestId.clear()
		this.pendingRequestContextByRequestId.clear()
		this.pendingRequestIdByResponseId.clear()
		this.pendingUnmappedRequestIdQueue = []
		this.draftResponseTextByResponseId.clear()
		this.toolArgumentsByResponseId.clear()
		this.draftRequestIdsByItemId.clear()
		this.supersededDraftRequestIdSet.clear()
		this.latestDraftSequenceByItemId.clear()

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

	public submitDraftInput(input: TranslateDraftInputPayload): void {
		const normalizedText = input.text.trim()
		if (!normalizedText || !this.isConnected()) return
		const previousSequence = this.latestDraftSequenceByItemId.get(input.itemId) ?? 0
		const nextSequence = Math.max(previousSequence, input.draftSequence)
		this.latestDraftSequenceByItemId.set(input.itemId, nextSequence)
		const pendingDraftRequestIds = this.draftRequestIdsByItemId.get(input.itemId)
		if (pendingDraftRequestIds) {
			pendingDraftRequestIds.forEach(requestId => {
				this.supersededDraftRequestIdSet.add(requestId)
			})
		}
		this.requestDraftResponse({
			draftSequence: nextSequence,
			inputOrigin: input.inputOrigin,
			itemId: input.itemId,
			sourceText: normalizedText
		})
	}

	public submitFinalInput(input: TranslateInputPayload): void {
		const normalizedText = input.text.trim()
		if (!normalizedText || !this.isConnected()) return
		this.requestFinalResponse({
			inputOrigin: input.inputOrigin,
			itemId: input.itemId,
			sourceText: normalizedText
		})
	}

	public submitInput(input: TranslateInputPayload): void {
		this.submitFinalInput(input)
	}

	public updateTranslateSettings(settings: LiveTranslateSettings): void {
		this.settings = settings
		this.sendSessionUpdate({
			audio: {
				input: {
					turn_detection: {
						create_response: false,
						eagerness: 'high',
						interrupt_response: false,
						type: 'semantic_vad'
					}
				}
			},
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
		context: PendingResponseContext,
		translatedText: string,
		responseId?: string
	): LiveTranslateResultPatch {
		return {
			direction: 'my_to_target',
			inputOrigin: context.inputOrigin,
			itemId: context.itemId,
			sourceLanguageCode: 'und',
			sourceText: context.sourceText,
			status: 'error',
			targetLanguageCode: 'und',
			translatedText,
			...(responseId ? { responseId } : {})
		}
	}

	private clearPendingRequestState(requestId: string): null | PendingResponseContext {
		const context = this.pendingRequestContextByRequestId.get(requestId) ?? null
		this.pendingRequestContextByRequestId.delete(requestId)
		this.pendingUnmappedRequestIdQueue = this.pendingUnmappedRequestIdQueue.filter(
			candidateRequestId => candidateRequestId !== requestId
		)
		this.pendingRequestIdByResponseId.forEach((mappedRequestId, responseId) => {
			if (mappedRequestId !== requestId) return
			this.pendingRequestIdByResponseId.delete(responseId)
			this.draftResponseTextByResponseId.delete(responseId)
			this.toolArgumentsByResponseId.delete(responseId)
		})
		const timeoutId = this.pendingRequestTimeoutByRequestId.get(requestId)
		if (typeof timeoutId === 'number') window.clearTimeout(timeoutId)
		this.pendingRequestTimeoutByRequestId.delete(requestId)
		if (context?.requestKind === 'draft') {
			const draftRequestIdSet = this.draftRequestIdsByItemId.get(context.itemId)
			draftRequestIdSet?.delete(requestId)
			if (!draftRequestIdSet || draftRequestIdSet.size === 0) {
				this.draftRequestIdsByItemId.delete(context.itemId)
			}
			this.supersededDraftRequestIdSet.delete(requestId)
		}
		return context
	}

	private requestDraftResponse(
		contextInput: Omit<PendingResponseContext, 'requestId' | 'requestKind'>
	): void {
		const requestId = crypto.randomUUID()
		const context: PendingResponseContext = {
			...contextInput,
			requestId,
			requestKind: 'draft'
		}
		const draftRequestIdSet = this.draftRequestIdsByItemId.get(context.itemId) ?? new Set<string>()
		draftRequestIdSet.add(requestId)
		this.draftRequestIdsByItemId.set(context.itemId, draftRequestIdSet)
		this.pendingRequestContextByRequestId.set(requestId, context)
		this.pendingUnmappedRequestIdQueue.push(requestId)

		const timeoutId = window.setTimeout(() => {
			const timedOutContext = this.clearPendingRequestState(requestId)
			if (!timedOutContext || timedOutContext.requestKind !== 'draft') return
			if (this.isDraftResponseSuperseded(timedOutContext)) return
			emitLiveTranslateLog('warn', 'draft_timeout', {
				itemId: timedOutContext.itemId,
				requestId: timedOutContext.requestId
			})
		}, draftTranslationResponseTimeoutMilliseconds)
		this.pendingRequestTimeoutByRequestId.set(requestId, timeoutId)
		emitLiveTranslateLog('info', 'draft_request_sent', {
			draftSequence: context.draftSequence,
			itemId: context.itemId,
			requestId
		})

		this.sendEvent({
			response: {
				conversation: 'none',
				input: [
					{
						content: [
							{
								text: context.sourceText,
								type: 'input_text'
							}
						],
						role: 'user',
						type: 'message'
					}
				],
				instructions: createDraftInstructions(
					this.settings.myLanguageCode,
					this.settings.translateToLanguageCode
				),
				metadata: {
					draft_sequence: String(context.draftSequence ?? 0),
					input_origin: context.inputOrigin,
					request_id: requestId,
					request_kind: context.requestKind,
					source_item_id: context.itemId
				},
				output_modalities: ['text'],
				tool_choice: 'none',
				tools: []
			},
			type: 'response.create'
		})
	}

	private requestFinalResponse(
		contextInput: Omit<PendingResponseContext, 'requestId' | 'requestKind'>
	): void {
		const requestId = crypto.randomUUID()
		const context: PendingResponseContext = {
			...contextInput,
			requestId,
			requestKind: 'final'
		}
		this.pendingRequestContextByRequestId.set(requestId, context)
		this.pendingUnmappedRequestIdQueue.push(requestId)

		const timeoutId = window.setTimeout(() => {
			const timedOutContext = this.clearPendingRequestState(requestId)
			if (!timedOutContext || timedOutContext.requestKind !== 'final') return
			const errorPatch = this.createErrorPatch(
				timedOutContext,
				'Translation timed out before tool output was returned.'
			)
			this.callbacks.onResultPatch(errorPatch)
			this.callbacks.onError(errorPatch.translatedText)
		}, finalTranslationResponseTimeoutMilliseconds)
		this.pendingRequestTimeoutByRequestId.set(requestId, timeoutId)
		emitLiveTranslateLog('info', 'final_request_sent', {
			itemId: context.itemId,
			requestId
		})

		this.sendEvent({
			response: {
				conversation: 'none',
				input: [
					{
						content: [
							{
								text: context.sourceText,
								type: 'input_text'
							}
						],
						role: 'user',
						type: 'message'
					}
				],
				instructions: createTranslateInstructions(
					this.settings.myLanguageCode,
					this.settings.translateToLanguageCode
				),
				metadata: {
					input_origin: context.inputOrigin,
					request_id: requestId,
					request_kind: context.requestKind,
					source_item_id: context.itemId
				},
				output_modalities: ['text'],
				tool_choice: buildToolChoice(),
				tools: [buildPublishTranslationToolDefinition()]
			},
			type: 'response.create'
		})
	}

	private isDraftResponseSuperseded(context: PendingResponseContext): boolean {
		if (context.requestKind !== 'draft') return false
		if (this.supersededDraftRequestIdSet.has(context.requestId)) return true
		const latestSequence = this.latestDraftSequenceByItemId.get(context.itemId)
		if (typeof latestSequence !== 'number') return false
		return (context.draftSequence ?? 0) < latestSequence
	}

	private emitDraftPatch(
		context: PendingResponseContext,
		translatedText: string,
		responseId: null | string,
		isDone: boolean
	): void {
		const safeText = translatedText.trim()
		if (!safeText) return
		const parsedPatch = TranslationDraftDeltaSchema.safeParse({
			draftSequence: context.draftSequence ?? 0,
			itemId: context.itemId,
			responseId: responseId ?? undefined,
			translatedText: safeText
		})
		if (!parsedPatch.success) return
		const patch: LiveTranslateDraftPatch = {
			draftSequence: parsedPatch.data.draftSequence,
			inputOrigin: context.inputOrigin,
			itemId: context.itemId,
			translatedText: parsedPatch.data.translatedText,
			...(parsedPatch.data.responseId ? { responseId: parsedPatch.data.responseId } : {})
		}
		if (isDone) this.callbacks.onDraftDonePatch(patch)
		else this.callbacks.onDraftDeltaPatch(patch)
	}

	private handleResponseCreatedEvent(
		event: ReturnType<typeof ResponseCreatedEventSchema.parse>
	): void {
		const responseId = parseStringValue(event.response?.id)
		if (!responseId) return
		const metadataRequestId = parseStringValue(event.response?.metadata?.request_id)
		const requestId = (() => {
			if (metadataRequestId && this.pendingRequestContextByRequestId.has(metadataRequestId)) {
				return metadataRequestId
			}
			while (this.pendingUnmappedRequestIdQueue.length > 0) {
				const fallbackRequestId = this.pendingUnmappedRequestIdQueue.shift()
				if (!fallbackRequestId) continue
				if (!this.pendingRequestContextByRequestId.has(fallbackRequestId)) continue
				return fallbackRequestId
			}
			return null
		})()
		if (!requestId) {
			emitLiveTranslateLog('warn', 'response_created_without_request_mapping', { responseId })
			return
		}
		this.pendingRequestIdByResponseId.set(responseId, requestId)
	}

	private handleResponseOutputTextDeltaEvent(
		event: ReturnType<typeof ResponseOutputTextDeltaEventSchema.parse>
	): void {
		const responseId = parseStringValue(event.response_id)
		if (!responseId || !event.delta) return
		const requestId = this.pendingRequestIdByResponseId.get(responseId)
		if (!requestId) return
		const context = this.pendingRequestContextByRequestId.get(requestId)
		if (!context || context.requestKind !== 'draft') return
		if (this.isDraftResponseSuperseded(context)) return
		const nextText = `${this.draftResponseTextByResponseId.get(responseId) ?? ''}${event.delta}`
		this.draftResponseTextByResponseId.set(responseId, nextText)
		this.emitDraftPatch(context, nextText, responseId, false)
	}

	private handleResponseOutputTextDoneEvent(
		event: ReturnType<typeof ResponseOutputTextDoneEventSchema.parse>
	): void {
		const responseId = parseStringValue(event.response_id)
		if (!responseId) return
		const requestId = this.pendingRequestIdByResponseId.get(responseId)
		if (!requestId) return
		const context = this.pendingRequestContextByRequestId.get(requestId)
		if (!context || context.requestKind !== 'draft') return
		if (this.isDraftResponseSuperseded(context)) return
		const nextText =
			parseStringValue(event.text) ?? this.draftResponseTextByResponseId.get(responseId) ?? ''
		this.draftResponseTextByResponseId.set(responseId, nextText)
		this.emitDraftPatch(context, nextText, responseId, true)
	}

	private storeFunctionCallArgumentsByResponseId(
		responseId: null | string,
		argumentsDelta: null | string
	): void {
		if (!responseId || !argumentsDelta) return
		const previousArguments = this.toolArgumentsByResponseId.get(responseId) ?? ''
		this.toolArgumentsByResponseId.set(responseId, `${previousArguments}${argumentsDelta}`)
	}

	private handleResponseFunctionCallArgumentsDeltaEvent(
		event: ReturnType<typeof ResponseFunctionCallArgumentsDeltaEventSchema.parse>
	): void {
		const responseId = parseStringValue(event.response_id)
		const requestId = responseId ? this.pendingRequestIdByResponseId.get(responseId) : null
		const context = requestId ? this.pendingRequestContextByRequestId.get(requestId) : null
		if (!context || context.requestKind !== 'final') return
		const toolName = parseStringValue(event.item?.name) ?? parseStringValue(event.name)
		if (toolName !== 'publish_translation') return
		const argumentsDelta = parseStringValue(event.delta) ?? parseStringValue(event.item?.arguments)
		this.storeFunctionCallArgumentsByResponseId(responseId, argumentsDelta)
	}

	private handleResponseFunctionCallArgumentsDoneEvent(
		event: ReturnType<typeof ResponseFunctionCallArgumentsDoneEventSchema.parse>
	): void {
		const responseId = parseStringValue(event.response_id)
		const requestId = responseId ? this.pendingRequestIdByResponseId.get(responseId) : null
		const context = requestId ? this.pendingRequestContextByRequestId.get(requestId) : null
		if (!context || context.requestKind !== 'final') return
		const toolName = parseStringValue(event.item?.name) ?? parseStringValue(event.name)
		if (toolName !== 'publish_translation') return
		const argumentsValue =
			parseStringValue(event.item?.arguments) ?? parseStringValue(event.arguments) ?? null
		if (!argumentsValue) return
		this.toolArgumentsByResponseId.set(responseId ?? context.requestId, argumentsValue)
	}

	private handleResponseOutputItemDoneEvent(
		event: ReturnType<typeof ResponseOutputItemDoneEventSchema.parse>
	): void {
		if (event.item.type !== 'function_call') return
		if (parseStringValue(event.item.name) !== 'publish_translation') return
		const responseId = parseStringValue(event.response_id)
		const argumentsValue = parseStringValue(event.item.arguments)
		if (!argumentsValue) return
		this.toolArgumentsByResponseId.set(
			responseId ?? event.item.id ?? crypto.randomUUID(),
			argumentsValue
		)
	}

	private handleResponseDoneEvent(event: ReturnType<typeof ResponseDoneEventSchema.parse>): void {
		const responseId = parseStringValue(event.response?.id) ?? parseStringValue(event.response_id)
		const metadata =
			event.response?.metadata && typeof event.response.metadata === 'object'
				? (event.response.metadata as Record<string, unknown>)
				: {}
		const requestId =
			parseStringValue(metadata.request_id) ??
			(responseId ? this.pendingRequestIdByResponseId.get(responseId) : null)
		if (!requestId) return
		const context = this.pendingRequestContextByRequestId.get(requestId)
		const clearedContext = this.clearPendingRequestState(requestId)
		if (!context || !clearedContext) return

		const responseStatus = parseStringValue(event.response?.status)?.toLowerCase() ?? null
		if (context.requestKind === 'draft') {
			if (this.isDraftResponseSuperseded(context)) return
			const draftText = responseId ? (this.draftResponseTextByResponseId.get(responseId) ?? '') : ''
			this.emitDraftPatch(context, draftText, responseId, true)
			if (responseStatus && !['completed', 'incomplete'].includes(responseStatus)) {
				this.callbacks.onError(`Draft translation ended with status ${responseStatus}.`)
			}
			return
		}

		if (responseStatus && responseStatus !== 'completed') {
			const statusDetails = event.response?.status_details
			const reason =
				parseStringValue((statusDetails as Record<string, unknown> | null)?.reason) ??
				parseStringValue((statusDetails as Record<string, unknown> | null)?.message) ??
				`Translation failed with status ${responseStatus}.`
			const errorPatch = this.createErrorPatch(context, reason, responseId ?? undefined)
			this.callbacks.onResultPatch(errorPatch)
			this.callbacks.onError(reason)
			return
		}

		const directFunctionCall = (event.response?.output ?? []).find(
			item => item.type === 'function_call' && item.name === 'publish_translation'
		)
		const accumulatedArguments = responseId ? this.toolArgumentsByResponseId.get(responseId) : null
		const inferredArguments = tryExtractToolArgumentsFromResponseOutput(event.response?.output)
		const rawToolArguments =
			(typeof directFunctionCall?.arguments === 'string' ? directFunctionCall.arguments : null) ??
			accumulatedArguments ??
			inferredArguments

		if (!rawToolArguments) {
			emitLiveTranslateLog('warn', 'missing_publish_translation_tool_call', {
				itemId: context.itemId,
				requestId,
				responseId: responseId ?? undefined
			})
			const errorPatch = this.createErrorPatch(
				context,
				'No valid publish_translation tool call was returned.',
				responseId ?? undefined
			)
			this.callbacks.onResultPatch(errorPatch)
			this.callbacks.onError(errorPatch.translatedText)
			return
		}

		try {
			const parsedArguments = JSON.parse(rawToolArguments) as unknown
			const parsedResult = PublishTranslationToolArgumentsSchema.parse(parsedArguments)
			emitLiveTranslateLog('info', 'final_result_patch', {
				direction: parsedResult.direction,
				itemId: context.itemId,
				responseId: responseId ?? undefined
			})
			this.callbacks.onResultPatch({
				direction: parsedResult.direction,
				inputOrigin: context.inputOrigin,
				itemId: context.itemId,
				sourceLanguageCode: parsedResult.sourceLanguageCode,
				sourceText: parsedResult.sourceText,
				status: 'final',
				targetLanguageCode: parsedResult.targetLanguageCode,
				translatedText: parsedResult.translatedText,
				...(responseId ? { responseId } : {})
			})
		} catch {
			emitLiveTranslateLog('error', 'malformed_tool_arguments', {
				itemId: context.itemId,
				requestId,
				responseId: responseId ?? undefined
			})
			const errorPatch = this.createErrorPatch(
				context,
				'Tool arguments were malformed and could not be parsed.',
				responseId ?? undefined
			)
			this.callbacks.onResultPatch(errorPatch)
			this.callbacks.onError(errorPatch.translatedText)
		}
	}

	private handleRealtimeErrorEvent(event: ReturnType<typeof RealtimeErrorEventSchema.parse>): void {
		const message = event.error?.message || 'Realtime session error'
		emitLiveTranslateLog('error', 'realtime_error', { message })
		this.callbacks.onError(message)
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
				case 'response.output_text.delta': {
					const event = ResponseOutputTextDeltaEventSchema.parse(candidate)
					this.handleResponseOutputTextDeltaEvent(event)
					return
				}
				case 'response.output_text.done': {
					const event = ResponseOutputTextDoneEventSchema.parse(candidate)
					this.handleResponseOutputTextDoneEvent(event)
					return
				}
				case 'response.function_call_arguments.delta': {
					const event = ResponseFunctionCallArgumentsDeltaEventSchema.parse(candidate)
					this.handleResponseFunctionCallArgumentsDeltaEvent(event)
					return
				}
				case 'response.function_call_arguments.done': {
					const event = ResponseFunctionCallArgumentsDoneEventSchema.parse(candidate)
					this.handleResponseFunctionCallArgumentsDoneEvent(event)
					return
				}
				case 'response.output_item.done': {
					const event = ResponseOutputItemDoneEventSchema.parse(candidate)
					this.handleResponseOutputItemDoneEvent(event)
					return
				}
				case 'response.done': {
					const event = ResponseDoneEventSchema.parse(candidate)
					this.handleResponseDoneEvent(event)
					return
				}
				case 'error': {
					const event = RealtimeErrorEventSchema.parse(candidate)
					this.handleRealtimeErrorEvent(event)
					return
				}
				default:
					return
			}
		} catch {
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
