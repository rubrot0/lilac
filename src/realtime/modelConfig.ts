import { z } from 'zod'

export const chatRealtimeModelValues = ['gpt-realtime-1.5'] as const
export const transcriptionModelValues = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe'] as const
export const translationModelValues = ['gpt-5.3-chat-latest', 'gpt-5.3-codex'] as const
export const transcriptionAsrProfileValues = ['accurate', 'fast'] as const

export const ChatRealtimeModelSchema = z.enum(chatRealtimeModelValues)
export const TranscriptionModelSchema = z.enum(transcriptionModelValues)
export const TranslationModelSchema = z.enum(translationModelValues)
export const TranscriptionAsrProfileSchema = z.enum(transcriptionAsrProfileValues)

export const defaultChatRealtimeModel = 'gpt-realtime-1.5'
export const defaultTranscriptionModel = 'gpt-4o-transcribe'
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

export function resolveTranscriptionModelForAsrProfile(
	asrProfile: null | TranscriptionAsrProfile | undefined
): TranscriptionModel {
	if (asrProfile === 'fast') return fastTranscriptionModel
	return defaultTranscriptionModel
}
