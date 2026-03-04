'use server'

import {
	defaultTranscriptionModel,
	resolveTranscriptionModelForAsrProfile
} from '@/realtime/modelConfig'
import {
	CreateRealtimeClientSecretActionInputSchema,
	CreateRealtimeClientSecretActionOutputSchema,
	CreateRealtimeTranscriptionSessionActionInputSchema,
	CreateRealtimeTranscriptionSessionActionOutputSchema,
	CreateTranslateRealtimeClientSecretActionInputSchema,
	CreateTranslateRealtimeClientSecretActionOutputSchema,
	parseClientSecretResponse
} from '@/realtime/schemas'
import env from '~/env'

const openAiApiBaseUrl = 'https://api.openai.com/v1'
const defaultRequestHeaders = {
	Authorization: `Bearer ${env.OPENAI_API_KEY}`,
	'Content-Type': 'application/json'
} satisfies HeadersInit

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
	const transcriptionModel = resolveTranscriptionModelForAsrProfile(parsedInput.asrProfile)

	const payload = await postOpenAi('/realtime/transcription_sessions', {
		include: ['item.input_audio_transcription.logprobs'],
		input_audio_format: 'pcm16',
		input_audio_transcription: {
			model: transcriptionModel,
			prompt: 'Transcribe spoken audio faithfully. Preserve punctuation and proper nouns.'
		},
		turn_detection: {
			eagerness: parsedInput.turnEagerness,
			type: 'semantic_vad'
		}
	})

	const parsedSecret = parseClientSecretResponse(payload)
	return CreateRealtimeTranscriptionSessionActionOutputSchema.parse(parsedSecret)
}
