import { z } from 'zod'

export const chatRealtimeModelValues = ['gpt-realtime-1.5'] as const
export const transcriptionModelValues = [
	'gpt-4o-transcribe',
	'gpt-4o-transcribe-latest',
	'gpt-4o-mini-transcribe'
] as const
export const translationModelValues = ['gpt-5.3-chat-latest', 'gpt-5.3-codex'] as const
export const transcriptionAsrProfileValues = ['accurate', 'fast'] as const

export const ChatRealtimeModelSchema = z.enum(chatRealtimeModelValues)
export const TranscriptionModelSchema = z.enum(transcriptionModelValues)
export const TranslationModelSchema = z.enum(translationModelValues)
export const TranscriptionAsrProfileSchema = z.enum(transcriptionAsrProfileValues)

export const defaultChatRealtimeModel = 'gpt-realtime-1.5'
export const defaultTranscriptionModel = 'gpt-4o-transcribe'
export const latestTranscriptionModel = 'gpt-4o-transcribe-latest'
export const fastTranscriptionModel = 'gpt-4o-mini-transcribe'
export const defaultTranscriptionAsrProfile = 'accurate'
export const defaultTranslationModel = 'gpt-5.3-chat-latest'

export const AllowedLilacModelSchema = z.union([
	ChatRealtimeModelSchema,
	TranscriptionModelSchema,
	TranslationModelSchema
])

export type ChatRealtimeModel = z.infer<typeof ChatRealtimeModelSchema>
export type TranscriptionModel = z.infer<typeof TranscriptionModelSchema>
export type TranslationModel = z.infer<typeof TranslationModelSchema>
export type TranscriptionAsrProfile = z.infer<typeof TranscriptionAsrProfileSchema>

function resolveModelOverride<Value extends string>(
	overrideValue: undefined | Value,
	fallbackValue: Value,
	schema: z.ZodType<Value>
): Value {
	const parsedOverride = schema.safeParse(overrideValue)
	return parsedOverride.success ? parsedOverride.data : fallbackValue
}

export function resolveChatRealtimeModelFromEnvironment(): ChatRealtimeModel {
	return resolveModelOverride(
		process.env.NEXT_PUBLIC_LILAC_REALTIME_MODEL as ChatRealtimeModel | undefined,
		defaultChatRealtimeModel,
		ChatRealtimeModelSchema
	)
}

export function resolveTranscriptionModelForAsrProfile(
	asrProfile: null | TranscriptionAsrProfile | undefined
): TranscriptionModel {
	if (asrProfile === 'fast') return fastTranscriptionModel
	return defaultTranscriptionModel
}

export function resolveTranscriptionModelFromEnvironment(
	asrProfile: null | TranscriptionAsrProfile | undefined
): TranscriptionModel {
	return resolveModelOverride(
		process.env.NEXT_PUBLIC_LILAC_TRANSCRIPTION_MODEL as TranscriptionModel | undefined,
		resolveTranscriptionModelForAsrProfile(asrProfile),
		TranscriptionModelSchema
	)
}
