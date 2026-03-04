'use server'

import { z } from 'zod'
import { defaultTranscriptionModel } from '@/realtime/modelConfig'
import {
	CreateRealtimeClientSecretActionInputSchema,
	CreateRealtimeClientSecretActionOutputSchema,
	CreateRealtimeTranscriptionSessionActionInputSchema,
	CreateRealtimeTranscriptionSessionActionOutputSchema,
	CreateTranslateRealtimeClientSecretActionInputSchema,
	CreateTranslateRealtimeClientSecretActionOutputSchema,
	PublishTranslationToolArgumentsSchema,
	parseClientSecretResponse,
	TranslateFallbackActionInputSchema,
	TranslateFallbackActionOutputSchema
} from '@/realtime/schemas'
import env from '~/env'

const openAiApiBaseUrl = 'https://api.openai.com/v1'
const defaultRequestHeaders = {
	Authorization: `Bearer ${env.OPENAI_API_KEY}`,
	'Content-Type': 'application/json'
} satisfies HeadersInit

const CreateChatCompletionResponseSchema = z
	.object({
		choices: z
			.array(
				z
					.object({
						message: z
							.object({
								content: z
									.union([
										z.string(),
										z.array(
											z
												.object({
													text: z.string().optional(),
													type: z.string().optional()
												})
												.passthrough()
										)
									])
									.optional()
							})
							.passthrough()
							.optional()
					})
					.passthrough()
			)
			.min(1)
	})
	.passthrough()

type OpenAiErrorPayload = {
	code?: string
	message: string
	param?: string
	status: number
	type?: string
}

class OpenAiRequestError extends Error {
	public code?: string
	public param?: string
	public status: number
	public type?: string

	public constructor(payload: OpenAiErrorPayload) {
		super(payload.message)
		this.name = 'OpenAiRequestError'
		if (typeof payload.code === 'string') this.code = payload.code
		if (typeof payload.param === 'string') this.param = payload.param
		this.status = payload.status
		if (typeof payload.type === 'string') this.type = payload.type
	}
}

async function parseJsonResponse(response: Response): Promise<unknown> {
	const responseText = await response.text()
	if (!responseText.trim()) return {}
	try {
		return JSON.parse(responseText) as unknown
	} catch {
		throw new Error(responseText)
	}
}

async function postOpenAi(path: string, body: unknown): Promise<unknown> {
	const response = await fetch(`${openAiApiBaseUrl}${path}`, {
		body: JSON.stringify(body),
		headers: defaultRequestHeaders,
		method: 'POST'
	})

	const payload = await parseJsonResponse(response)

	if (!response.ok) {
		const fallbackMessage = `OpenAI request failed (${response.status})`
		if (typeof payload === 'object' && payload !== null && 'error' in payload) {
			const openAiError = (
				payload as {
					error?: {
						code?: string
						message?: string
						param?: string
						type?: string
					}
				}
			).error
			throw new OpenAiRequestError({
				message: openAiError?.message || fallbackMessage,
				status: response.status,
				...(openAiError?.code ? { code: openAiError.code } : {}),
				...(openAiError?.param ? { param: openAiError.param } : {}),
				...(openAiError?.type ? { type: openAiError.type } : {})
			})
		}
		throw new OpenAiRequestError({
			message: fallbackMessage,
			status: response.status
		})
	}

	return payload
}

function createTranslateInstructions(
	myLanguageCode: string,
	translateToLanguageCode: string
): string {
	return [
		'You are Lilac, a deterministic live translator.',
		`My language: ${myLanguageCode}.`,
		`Translate to language: ${translateToLanguageCode}.`,
		'For each user utterance, detect whether it is in my language or the target language, and translate to the opposite side.',
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

function createFallbackTranslateInstructions(
	myLanguageCode: string,
	translateToLanguageCode: string
): string {
	return [
		'You are Lilac fallback translation.',
		`Language A: ${myLanguageCode}.`,
		`Language B: ${translateToLanguageCode}.`,
		'Detect whether input is language A or B and translate to the opposite language.',
		'Return only JSON matching the schema.',
		'Never include commentary, rationale, or extra keys.',
		'Preserve intent, tone, punctuation, and named entities.'
	].join('\n')
}

function extractChatCompletionMessageContent(payload: unknown): string {
	const parsedPayload = CreateChatCompletionResponseSchema.parse(payload)
	const firstChoice = parsedPayload.choices[0]
	if (!firstChoice) throw new Error('Chat completion did not include a choice.')
	const contentValue = firstChoice.message?.content
	if (typeof contentValue === 'string') {
		const normalizedContent = contentValue.trim()
		if (normalizedContent) return normalizedContent
	}
	if (Array.isArray(contentValue)) {
		let joinedText = ''
		for (const contentPart of contentValue) {
			if (!contentPart || typeof contentPart !== 'object') continue
			const textValue = (contentPart as { text?: unknown }).text
			if (typeof textValue !== 'string') continue
			joinedText += textValue
		}
		const normalizedJoinedText = joinedText.trim()
		if (normalizedJoinedText) return normalizedJoinedText
	}
	throw new Error('Chat completion did not include structured JSON text output.')
}

export async function createRealtimeClientSecretAction(input?: unknown): Promise<{
	expiresAt: number
	value: string
}> {
	const parsedInput = CreateRealtimeClientSecretActionInputSchema.parse(input ?? {})
	const silenceDurationMilliseconds = Math.round(parsedInput.turnDelaySeconds * 1000)

	const payload = await postOpenAi('/realtime/client_secrets', {
		expires_after: {
			anchor: 'created_at',
			seconds: 600
		},
		session: {
			audio: {
				input: {
					noise_reduction: {
						type: 'near_field'
					},
					transcription: {
						model: defaultTranscriptionModel
					},
					turn_detection: {
						silence_duration_ms: silenceDurationMilliseconds,
						type: 'server_vad'
					}
				},
				output: {
					voice: parsedInput.voice
				}
			},
			instructions: parsedInput.instructions ?? '',
			model: parsedInput.model,
			output_modalities: [parsedInput.speechOutputEnabled ? 'audio' : 'text'],
			type: 'realtime'
		}
	})

	const parsedSecret = parseClientSecretResponse(payload)
	return CreateRealtimeClientSecretActionOutputSchema.parse(parsedSecret)
}

export async function createTranslateRealtimeClientSecretAction(input: unknown): Promise<{
	expiresAt: number
	value: string
}> {
	const parsedInput = CreateTranslateRealtimeClientSecretActionInputSchema.parse(input)
	const instructions = createTranslateInstructions(
		parsedInput.myLanguageCode,
		parsedInput.translateToLanguageCode
	)

	const payload = await postOpenAi('/realtime/client_secrets', {
		expires_after: {
			anchor: 'created_at',
			seconds: 600
		},
		session: {
			instructions,
			model: parsedInput.model,
			output_modalities: ['text'],
			tool_choice: 'required',
			tools: [buildPublishTranslationToolDefinition()],
			type: 'realtime'
		}
	})

	const parsedSecret = parseClientSecretResponse(payload)
	return CreateTranslateRealtimeClientSecretActionOutputSchema.parse(parsedSecret)
}

export async function createRealtimeTranscriptionSessionAction(input: unknown): Promise<{
	expiresAt: number
	value: string
}> {
	const parsedInput = CreateRealtimeTranscriptionSessionActionInputSchema.parse(input)
	void parsedInput

	const payload = await postOpenAi('/realtime/transcription_sessions', {
		input_audio_format: 'pcm16',
		input_audio_transcription: {
			model: defaultTranscriptionModel,
			prompt: 'Transcribe spoken audio faithfully. Preserve punctuation and proper nouns.'
		},
		turn_detection: {
			eagerness: 'high',
			type: 'semantic_vad'
		}
	})

	const parsedSecret = parseClientSecretResponse(payload)
	return CreateRealtimeTranscriptionSessionActionOutputSchema.parse(parsedSecret)
}

export async function translateFallbackAction(
	input: unknown
): Promise<z.infer<typeof TranslateFallbackActionOutputSchema>> {
	const parsedInput = TranslateFallbackActionInputSchema.parse(input)

	try {
		const payload = await postOpenAi('/chat/completions', {
			messages: [
				{
					content: createFallbackTranslateInstructions(
						parsedInput.myLanguageCode,
						parsedInput.translateToLanguageCode
					),
					role: 'system'
				},
				{
					content: parsedInput.sourceText,
					role: 'user'
				}
			],
			model: parsedInput.model,
			response_format: {
				json_schema: {
					name: 'publish_translation',
					schema: {
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
					strict: true
				},
				type: 'json_schema'
			}
		})

		const messageContent = extractChatCompletionMessageContent(payload)
		const parsedResult = PublishTranslationToolArgumentsSchema.parse(
			JSON.parse(messageContent) as unknown
		)
		return TranslateFallbackActionOutputSchema.parse({
			ok: true,
			result: parsedResult
		})
	} catch (error) {
		const message =
			error instanceof Error && error.message ? error.message : 'Fallback translation failed.'
		const debugId = `fallback_${Date.now().toString(36)}`
		console.error('[translateFallbackAction]', debugId, message)
		return TranslateFallbackActionOutputSchema.parse({
			error: `Translation retry failed. (${debugId})`,
			ok: false
		})
	}
}
