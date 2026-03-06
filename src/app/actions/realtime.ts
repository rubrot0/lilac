'use server'

import { resolveRealtimeTranscriptionLanguageCode } from '@/realtime/languageCatalog'
import {
	defaultTranscriptionModel,
	resolveTranscriptionModelFromEnvironment
} from '@/realtime/modelConfig'
import {
	CreateRealtimeClientSecretActionInputSchema,
	CreateRealtimeClientSecretActionOutputSchema,
	CreateRealtimeTranscriptionSessionActionInputSchema,
	CreateRealtimeTranscriptionSessionActionOutputSchema,
	CreateTranslateRealtimeClientSecretActionInputSchema,
	CreateTranslateRealtimeClientSecretActionOutputSchema,
	parseClientSecretResponse,
	RetranscribeTranslateAudioActionInputSchema,
	RetranscribeTranslateAudioActionOutputSchema
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
		return responseText
	}
}

function isRetryableOpenAiStatus(status: number): boolean {
	switch (status) {
		case 408:
		case 429:
		case 500:
		case 502:
		case 503:
		case 504:
			return true
		default:
			return false
	}
}

function truncateErrorMessage(message: string, maximumLength = 240): string {
	return message.length <= maximumLength ? message : `${message.slice(0, maximumLength - 1)}…`
}

async function waitForRetryDelay(attemptNumber: number): Promise<void> {
	const delayMilliseconds = 250 * 2 ** Math.max(0, attemptNumber - 1)
	await new Promise(resolveDelay => setTimeout(resolveDelay, delayMilliseconds))
}

async function postOpenAi(path: string, body: unknown): Promise<unknown> {
	const maximumAttempts = 3
	for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
		try {
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
					message:
						typeof payload === 'string' && payload.trim()
							? truncateErrorMessage(payload.trim())
							: fallbackMessage,
					status: response.status
				})
			}

			return payload
		} catch (error) {
			const isRetryableError =
				error instanceof OpenAiRequestError
					? isRetryableOpenAiStatus(error.status)
					: error instanceof Error
						? /timeout|timed out|gateway time-out|gateway timeout|fetch failed/i.test(error.message)
						: false
			if (!isRetryableError || attemptNumber >= maximumAttempts) {
				throw error
			}
			await waitForRetryDelay(attemptNumber)
		}
	}
	throw new Error('OpenAI request exhausted retry attempts.')
}

async function postOpenAiMultipart(path: string, body: FormData): Promise<unknown> {
	const maximumAttempts = 3
	for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
		try {
			const response = await fetch(`${openAiApiBaseUrl}${path}`, {
				body,
				headers: {
					Authorization: `Bearer ${env.OPENAI_API_KEY}`
				},
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
					message:
						typeof payload === 'string' && payload.trim()
							? truncateErrorMessage(payload.trim())
							: fallbackMessage,
					status: response.status
				})
			}

			return payload
		} catch (error) {
			const isRetryableError =
				error instanceof OpenAiRequestError
					? isRetryableOpenAiStatus(error.status)
					: error instanceof Error
						? /timeout|timed out|gateway time-out|gateway timeout|fetch failed/i.test(error.message)
						: false
			if (!isRetryableError || attemptNumber >= maximumAttempts) {
				throw error
			}
			await waitForRetryDelay(attemptNumber)
		}
	}
	throw new Error('OpenAI multipart request exhausted retry attempts.')
}

function createWaveFileBufferFromPcm16Base64(audioPcm16Base64: string): Buffer {
	const pcmBuffer = Buffer.from(audioPcm16Base64, 'base64')
	const headerBuffer = Buffer.alloc(44)
	const sampleRateHertz = 24_000
	const channelCount = 1
	const bitsPerSample = 16
	const blockAlign = (channelCount * bitsPerSample) / 8
	const byteRate = sampleRateHertz * blockAlign

	headerBuffer.write('RIFF', 0)
	headerBuffer.writeUInt32LE(36 + pcmBuffer.length, 4)
	headerBuffer.write('WAVE', 8)
	headerBuffer.write('fmt ', 12)
	headerBuffer.writeUInt32LE(16, 16)
	headerBuffer.writeUInt16LE(1, 20)
	headerBuffer.writeUInt16LE(channelCount, 22)
	headerBuffer.writeUInt32LE(sampleRateHertz, 24)
	headerBuffer.writeUInt32LE(byteRate, 28)
	headerBuffer.writeUInt16LE(blockAlign, 32)
	headerBuffer.writeUInt16LE(bitsPerSample, 34)
	headerBuffer.write('data', 36)
	headerBuffer.writeUInt32LE(pcmBuffer.length, 40)

	return Buffer.concat([headerBuffer, pcmBuffer])
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

function buildChatOutputModalities(speechOutputEnabled: boolean): string[] {
	return [speechOutputEnabled ? 'audio' : 'text']
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
			output_modalities: buildChatOutputModalities(parsedInput.speechOutputEnabled),
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
	const transcriptionModel = resolveTranscriptionModelFromEnvironment(parsedInput.asrProfile)
	const transcriptionLanguageCode = resolveRealtimeTranscriptionLanguageCode(
		parsedInput.myLanguageCode
	)

	const payload = await postOpenAi('/realtime/transcription_sessions', {
		include: ['item.input_audio_transcription.logprobs'],
		input_audio_format: 'pcm16',
		input_audio_noise_reduction: {
			type: 'near_field'
		},
		input_audio_transcription: {
			model: transcriptionModel,
			...(transcriptionLanguageCode ? { language: transcriptionLanguageCode } : {})
		},
		turn_detection: null
	})

	const parsedSecret = parseClientSecretResponse(payload)
	return CreateRealtimeTranscriptionSessionActionOutputSchema.parse(parsedSecret)
}

export async function retranscribeTranslateAudioAction(input: unknown): Promise<{
	transcript: string
}> {
	const parsedInput = RetranscribeTranslateAudioActionInputSchema.parse(input)
	const transcriptionLanguageCode = resolveRealtimeTranscriptionLanguageCode(
		parsedInput.languageCode
	)
	const transcriptionModel = resolveTranscriptionModelFromEnvironment('accurate')
	const waveFileBuffer = createWaveFileBufferFromPcm16Base64(parsedInput.audioPcm16Base64)
	const formData = new FormData()
	formData.append(
		'file',
		new File([Uint8Array.from(waveFileBuffer)], 'utterance.wav', {
			type: 'audio/wav'
		})
	)
	formData.append('model', transcriptionModel)
	formData.append('response_format', 'json')
	formData.append('temperature', '0')
	if (transcriptionLanguageCode) {
		formData.append('language', transcriptionLanguageCode)
	}

	const payload = await postOpenAiMultipart('/audio/transcriptions', formData)
	const parsedPayload = RetranscribeTranslateAudioActionOutputSchema.parse(payload)
	return {
		transcript: parsedPayload.text.trim()
	}
}
