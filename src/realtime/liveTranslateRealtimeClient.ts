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
}

function createTranslateInstructions(
	myLanguageCode: string,
	translateToLanguageCode: string
): string {
	return [
		'You are Lilac, a deterministic live translator.',
		`My language: ${myLanguageCode}.`,
		`Translate to language: ${translateToLanguageCode}.`,
		'For each user utterance, detect whether source is my language or target language.',
		'If source is my language, translate to target and use direction my_to_target.',
		'If source is target language, translate to my language and use direction target_to_my.',
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

export class LiveTranslateRealtimeClient {
	private callbacks: LiveTranslateRealtimeClientCallbacks
	private completedToolArgumentsByResponseId = new Map<string, string>()
	private dataChannel: null | RTCDataChannel = null
	private generation = 0
	private pendingResponseContextByRequestId = new Map<string, PendingResponseContext>()
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
		this.requestTranslationResponse(input.itemId, input.inputOrigin)
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

		const pendingContext = requestId
			? (this.pendingResponseContextByRequestId.get(requestId) ?? null)
			: null
		if (requestId) this.pendingResponseContextByRequestId.delete(requestId)

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
		const toolArguments =
			typeof functionCall?.arguments === 'string' ? functionCall.arguments : fallbackToolArguments

		if (!toolArguments) {
			if (responseStatus && responseStatus !== 'completed') return
			this.callbacks.onResultPatch({
				direction: 'my_to_target',
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
				sourceText: '',
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
