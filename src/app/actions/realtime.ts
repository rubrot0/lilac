'use server'

import {
	CompactTranslationContextActionInputSchema,
	CompactTranslationContextActionOutputSchema,
	CreateRealtimeClientSecretActionInputSchema,
	CreateRealtimeClientSecretActionOutputSchema,
	CreateRealtimeTranscriptionSessionActionInputSchema,
	CreateRealtimeTranscriptionSessionActionOutputSchema,
	parseClientSecretResponse,
	TranslateUtteranceActionInputSchema,
	TranslateUtteranceActionOutputSchema
} from '@/realtime/schemas'
import type { TranslationContextEntry } from '@/realtime/sessionTypes'
import env from '~/env'

const openAiApiBaseUrl = 'https://api.openai.com/v1'
const defaultRequestHeaders = {
	Authorization: `Bearer ${env.OPENAI_API_KEY}`,
	'Content-Type': 'application/json'
} satisfies HeadersInit

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
			const candidate = (payload as { error?: { message?: string } }).error?.message
			throw new Error(candidate || fallbackMessage)
		}
		throw new Error(fallbackMessage)
	}

	return payload
}

function extractResponseOutputText(responsePayload: unknown): string {
	if (typeof responsePayload !== 'object' || responsePayload === null) {
		throw new Error('OpenAI Responses payload was not an object')
	}

	const payload = responsePayload as {
		output?: Array<{
			content?: Array<{
				text?: string
				type?: string
			}>
		}>
		output_text?: string
	}

	if (typeof payload.output_text === 'string' && payload.output_text.trim().length > 0) {
		return payload.output_text.trim()
	}

	const outputItems = Array.isArray(payload.output) ? payload.output : []
	for (const outputItem of outputItems) {
		const contentParts = Array.isArray(outputItem.content) ? outputItem.content : []
		for (const contentPart of contentParts) {
			if (contentPart.type === 'output_text' && typeof contentPart.text === 'string') {
				const normalizedText = contentPart.text.trim()
				if (normalizedText.length > 0) return normalizedText
			}
		}
	}

	throw new Error('OpenAI did not return output text for translation')
}

function renderContextForPrompt(context: TranslationContextEntry[]): string {
	if (!context.length) return '[]'
	return JSON.stringify(context)
}

function createTranslatePrompt(
	input: ReturnType<typeof TranslateUtteranceActionInputSchema.parse>
): string {
	const contextJson = renderContextForPrompt(input.context)
	const escapedUtteranceText = input.utteranceText

	if (input.settings.mode === 'translate') {
		return [
			'You are a deterministic translation engine for a two-language live conversation.',
			'Return JSON only.',
			`Primary language code: ${input.settings.primaryLanguageCode}.`,
			`Secondary language code: ${input.settings.secondaryLanguageCode}.`,
			'Detect whether the utterance is in primary or secondary language and translate to the opposite language.',
			'Direction must be exactly one of: primary_to_secondary, secondary_to_primary.',
			'Never add commentary or extra keys.',
			'Use recent context to keep references consistent.',
			`Recent context (JSON): ${contextJson}`,
			`Utterance: ${escapedUtteranceText}`
		].join('\n')
	}

	return [
		'You are a deterministic transcription translation engine for one-way translation.',
		'Return JSON only.',
		`Target language code: ${input.settings.targetLanguageCode}.`,
		'Detect the utterance language and translate only into the target language.',
		'Direction must be exactly: to_target.',
		'Never add commentary or extra keys.',
		'Use recent context to keep references consistent.',
		`Recent context (JSON): ${contextJson}`,
		`Utterance: ${escapedUtteranceText}`
	].join('\n')
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
					transcription: {
						model: 'gpt-4o-transcribe'
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
			output_modalities: ['audio', 'text'],
			type: 'realtime'
		}
	})

	const parsedSecret = parseClientSecretResponse(payload)
	return CreateRealtimeClientSecretActionOutputSchema.parse(parsedSecret)
}

export async function createRealtimeTranscriptionSessionAction(input?: unknown): Promise<{
	expiresAt: number
	value: string
}> {
	const parsedInput = CreateRealtimeTranscriptionSessionActionInputSchema.parse(input ?? {})
	const silenceDurationMilliseconds = Math.round(parsedInput.turnDelaySeconds * 1000)

	const payload = await postOpenAi('/realtime/transcription_sessions', {
		audio: {
			input: {
				transcription: {
					model: parsedInput.model,
					...(parsedInput.languageHint ? { language: parsedInput.languageHint } : {})
				},
				turn_detection: {
					create_response: false,
					interrupt_response: false,
					silence_duration_ms: silenceDurationMilliseconds,
					type: 'server_vad'
				}
			}
		},
		type: 'transcription'
	})

	const parsedSecret = parseClientSecretResponse(payload)
	return CreateRealtimeTranscriptionSessionActionOutputSchema.parse(parsedSecret)
}

export async function translateUtteranceAction(input: unknown): Promise<{
	detectedSourceLanguageCode: string
	direction: 'primary_to_secondary' | 'secondary_to_primary' | 'to_target'
	targetLanguageCode: string
	translatedText: string
}> {
	const parsedInput = TranslateUtteranceActionInputSchema.parse(input)
	const prompt = createTranslatePrompt(parsedInput)

	const responsePayload = await postOpenAi('/responses', {
		input: [
			{
				content: [
					{
						text: prompt,
						type: 'input_text'
					}
				],
				role: 'user'
			}
		],
		model: parsedInput.model,
		reasoning: {
			effort: 'minimal'
		},
		temperature: 0,
		text: {
			format: {
				name: 'lilac_translation',
				schema: {
					additionalProperties: false,
					properties: {
						detectedSourceLanguageCode: { type: 'string' },
						direction: {
							enum: ['primary_to_secondary', 'secondary_to_primary', 'to_target'],
							type: 'string'
						},
						targetLanguageCode: { type: 'string' },
						translatedText: { minLength: 1, type: 'string' }
					},
					required: ['detectedSourceLanguageCode', 'direction', 'targetLanguageCode', 'translatedText'],
					type: 'object'
				},
				strict: true,
				type: 'json_schema'
			}
		},
		truncation: 'auto'
	})

	const outputText = extractResponseOutputText(responsePayload)

	let parsedOutput: unknown
	try {
		parsedOutput = JSON.parse(outputText) as unknown
	} catch {
		throw new Error('Translation response was not valid JSON')
	}

	const translatedOutput = TranslateUtteranceActionOutputSchema.parse(parsedOutput)

	if (parsedInput.settings.mode === 'translate') {
		const allowedDirections = new Set(['primary_to_secondary', 'secondary_to_primary'])
		if (!allowedDirections.has(translatedOutput.direction)) {
			throw new Error('Translation response returned an invalid direction for translate mode')
		}
	}

	if (parsedInput.settings.mode === 'transcribe' && translatedOutput.direction !== 'to_target') {
		throw new Error('Translation response returned an invalid direction for transcribe mode')
	}

	return translatedOutput
}

function fallbackBoundedContext(context: TranslationContextEntry[]): TranslationContextEntry[] {
	if (context.length <= 16) return context
	return context.slice(context.length - 16)
}

export async function compactTranslationContextAction(input: unknown): Promise<{
	compactedContext: TranslationContextEntry[]
	performedCompaction: boolean
}> {
	const parsedInput = CompactTranslationContextActionInputSchema.parse(input)

	if (parsedInput.context.length <= 16) {
		return CompactTranslationContextActionOutputSchema.parse({
			compactedContext: parsedInput.context,
			performedCompaction: false
		})
	}

	const compactInput = parsedInput.context.map(entry => ({
		content: [
			{
				text: JSON.stringify(entry),
				type: 'input_text'
			}
		],
		role: 'user'
	}))

	try {
		await postOpenAi('/responses/compact', {
			input: compactInput,
			model: parsedInput.model
		})

		return CompactTranslationContextActionOutputSchema.parse({
			compactedContext: fallbackBoundedContext(parsedInput.context),
			performedCompaction: true
		})
	} catch {
		return CompactTranslationContextActionOutputSchema.parse({
			compactedContext: fallbackBoundedContext(parsedInput.context),
			performedCompaction: false
		})
	}
}
