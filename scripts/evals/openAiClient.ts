import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { z } from 'zod'

type OpenAiJsonResponse = Record<string, unknown>

type CreateChatCompletionJsonInput<Schema extends z.ZodType> = {
	maxCompletionTokens?: number
	messageList: unknown[]
	model: string
	responseSchema: Schema
}

type CreateResponsesJsonInput<Schema extends z.ZodType> = {
	inputList: unknown[]
	maxOutputTokens?: number
	model: string
	responseSchema: Schema
}

type AudioTranscriptionInput = {
	audioFilePath: string
	model: string
	prompt?: string
}

const openAiApiBaseUrl = 'https://api.openai.com/v1'
const openAiRequestTimeoutMilliseconds = 60_000
const openAiMaximumAttempts = 3

function requireOpenAiApiKey(): string {
	const openAiApiKey = process.env.OPENAI_API_KEY?.trim()
	if (!openAiApiKey) {
		throw new Error('OPENAI_API_KEY is required for eval runner.')
	}
	return openAiApiKey
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

function isRetryableStatus(status: number): boolean {
	switch (status) {
		case 408:
		case 409:
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

function isRetryableFetchError(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	return (
		error.name === 'AbortError' ||
		/aborted|fetch failed|gateway|timeout|timed out|temporarily unavailable/i.test(error.message)
	)
}

async function waitForRetryDelay(attemptNumber: number): Promise<void> {
	const delayMilliseconds = 300 * 2 ** Math.max(0, attemptNumber - 1)
	await new Promise(resolve => setTimeout(resolve, delayMilliseconds))
}

async function postOpenAiJson(path: string, body: unknown): Promise<OpenAiJsonResponse> {
	for (let attemptNumber = 1; attemptNumber <= openAiMaximumAttempts; attemptNumber += 1) {
		try {
			const response = await fetch(`${openAiApiBaseUrl}${path}`, {
				body: JSON.stringify(body),
				headers: {
					Authorization: `Bearer ${requireOpenAiApiKey()}`,
					'Content-Type': 'application/json'
				},
				method: 'POST',
				signal: AbortSignal.timeout(openAiRequestTimeoutMilliseconds)
			})
			const payload = await parseJsonResponse(response)
			if (!response.ok) {
				const errorMessage =
					typeof payload === 'object' &&
					payload !== null &&
					'error' in payload &&
					typeof payload.error === 'object' &&
					payload.error !== null &&
					'message' in payload.error &&
					typeof payload.error.message === 'string'
						? payload.error.message
						: `OpenAI request failed (${response.status})`
				if (isRetryableStatus(response.status) && attemptNumber < openAiMaximumAttempts) {
					await waitForRetryDelay(attemptNumber)
					continue
				}
				throw new Error(errorMessage)
			}
			if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
				throw new Error('Expected OpenAI JSON object response.')
			}
			return payload as OpenAiJsonResponse
		} catch (error) {
			if (attemptNumber >= openAiMaximumAttempts || !isRetryableFetchError(error)) {
				throw error
			}
			await waitForRetryDelay(attemptNumber)
		}
	}
	throw new Error('OpenAI JSON request exhausted retry attempts.')
}

function extractChatCompletionText(payload: OpenAiJsonResponse): string {
	const choiceList = Array.isArray(payload.choices) ? payload.choices : []
	const firstChoice = choiceList[0]
	if (!firstChoice || typeof firstChoice !== 'object') {
		throw new Error('Chat Completions response did not include choices.')
	}
	const message =
		'message' in firstChoice && firstChoice.message && typeof firstChoice.message === 'object'
			? (firstChoice.message as Record<string, unknown>)
			: null
	if (!message) {
		throw new Error('Chat Completions response did not include a message.')
	}
	if (typeof message.content === 'string') return message.content
	if (Array.isArray(message.content)) {
		const textPartList = message.content
			.map(contentPart => {
				if (!contentPart || typeof contentPart !== 'object') return null
				const contentPartRecord = contentPart as Record<string, unknown>
				if (typeof contentPartRecord.text === 'string') return contentPartRecord.text
				return null
			})
			.filter((value): value is string => typeof value === 'string' && value.length > 0)
		if (textPartList.length > 0) return textPartList.join('\n').trim()
	}
	throw new Error('Chat Completions response did not include text content.')
}

function extractResponsesText(payload: OpenAiJsonResponse): string {
	const directOutputText = typeof payload.output_text === 'string' ? payload.output_text.trim() : ''
	if (directOutputText) return directOutputText

	const outputItemList = Array.isArray(payload.output) ? payload.output : []
	const textPartList: string[] = []
	for (const outputItem of outputItemList) {
		if (!outputItem || typeof outputItem !== 'object') continue
		const outputItemRecord = outputItem as Record<string, unknown>
		const contentPartList = Array.isArray(outputItemRecord.content) ? outputItemRecord.content : []
		for (const contentPart of contentPartList) {
			if (!contentPart || typeof contentPart !== 'object') continue
			const contentPartRecord = contentPart as Record<string, unknown>
			const textValue =
				typeof contentPartRecord.text === 'string'
					? contentPartRecord.text
					: typeof contentPartRecord.output_text === 'string'
						? contentPartRecord.output_text
						: null
			if (!textValue) continue
			textPartList.push(textValue)
		}
	}
	if (textPartList.length === 0) {
		throw new Error('Responses API output did not include text content.')
	}
	return textPartList.join('\n').trim()
}

function parseJsonText<Schema extends z.ZodType>(
	jsonText: string,
	responseSchema: Schema,
	contextLabel: string
): z.infer<Schema> {
	let parsedJson: unknown
	try {
		parsedJson = JSON.parse(jsonText)
	} catch (error) {
		const fencedJsonMatch =
			jsonText.match(/```json\s*([\s\S]+?)```/i) ?? jsonText.match(/```\s*([\s\S]+?)```/i)
		if (fencedJsonMatch?.[1]) {
			try {
				parsedJson = JSON.parse(fencedJsonMatch[1].trim())
			} catch {
				throw new Error(
					`${contextLabel} did not return valid JSON: ${error instanceof Error ? error.message : 'unknown'}`
				)
			}
		} else {
			const firstBraceIndex = jsonText.indexOf('{')
			const lastBraceIndex = jsonText.lastIndexOf('}')
			if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
				try {
					parsedJson = JSON.parse(jsonText.slice(firstBraceIndex, lastBraceIndex + 1))
				} catch {
					throw new Error(
						`${contextLabel} did not return valid JSON: ${error instanceof Error ? error.message : 'unknown'}`
					)
				}
			} else {
				throw new Error(
					`${contextLabel} did not return valid JSON: ${error instanceof Error ? error.message : 'unknown'}`
				)
			}
		}
	}
	return responseSchema.parse(parsedJson)
}

export async function createChatCompletionJson<Schema extends z.ZodType>(
	input: CreateChatCompletionJsonInput<Schema>
): Promise<z.infer<Schema>> {
	const payload = await postOpenAiJson('/chat/completions', {
		max_completion_tokens: input.maxCompletionTokens,
		messages: input.messageList,
		model: input.model
	})
	return parseJsonText(
		extractChatCompletionText(payload),
		input.responseSchema,
		`Chat completion (${input.model})`
	)
}

export async function createResponsesJson<Schema extends z.ZodType>(
	input: CreateResponsesJsonInput<Schema>
): Promise<z.infer<Schema>> {
	const payload = await postOpenAiJson('/responses', {
		input: input.inputList,
		max_output_tokens: input.maxOutputTokens,
		model: input.model,
		text: {
			format: {
				type: 'json_object'
			}
		}
	})
	return parseJsonText(
		extractResponsesText(payload),
		input.responseSchema,
		`Responses request (${input.model})`
	)
}

export async function transcribeAudioFile(input: AudioTranscriptionInput): Promise<string> {
	const fileBytes = await readFile(input.audioFilePath)
	const formData = new FormData()
	formData.append(
		'file',
		new File([fileBytes], basename(input.audioFilePath), { type: 'audio/wav' })
	)
	formData.append('model', input.model)
	if (input.prompt) formData.append('prompt', input.prompt)

	for (let attemptNumber = 1; attemptNumber <= openAiMaximumAttempts; attemptNumber += 1) {
		try {
			const response = await fetch(`${openAiApiBaseUrl}/audio/transcriptions`, {
				body: formData,
				headers: {
					Authorization: `Bearer ${requireOpenAiApiKey()}`
				},
				method: 'POST',
				signal: AbortSignal.timeout(openAiRequestTimeoutMilliseconds)
			})
			const payload = await parseJsonResponse(response)
			if (!response.ok) {
				const errorMessage =
					typeof payload === 'object' &&
					payload !== null &&
					'error' in payload &&
					typeof payload.error === 'object' &&
					payload.error !== null &&
					'message' in payload.error &&
					typeof payload.error.message === 'string'
						? payload.error.message
						: `Audio transcription failed (${response.status})`
				if (isRetryableStatus(response.status) && attemptNumber < openAiMaximumAttempts) {
					await waitForRetryDelay(attemptNumber)
					continue
				}
				throw new Error(errorMessage)
			}
			const parsedPayload = z
				.object({
					text: z.string().min(1)
				})
				.parse(payload)
			return parsedPayload.text.trim()
		} catch (error) {
			if (attemptNumber >= openAiMaximumAttempts || !isRetryableFetchError(error)) {
				throw error
			}
			await waitForRetryDelay(attemptNumber)
		}
	}
	throw new Error('Audio transcription request exhausted retry attempts.')
}

export async function readAudioFileAsBase64(audioFilePath: string): Promise<string> {
	const fileBuffer = await readFile(audioFilePath)
	return Buffer.from(fileBuffer).toString('base64')
}
