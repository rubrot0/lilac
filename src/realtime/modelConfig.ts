import { z } from 'zod'

export const chatRealtimeModelValues = ['gpt-realtime-1.5'] as const
export const transcriptionModelValues = ['gpt-4o-transcribe'] as const
export const translationModelValues = ['gpt-5.3-codex'] as const

export const ChatRealtimeModelSchema = z.enum(chatRealtimeModelValues)
export const TranscriptionModelSchema = z.enum(transcriptionModelValues)
export const TranslationModelSchema = z.enum(translationModelValues)

export const defaultChatRealtimeModel = 'gpt-realtime-1.5'
export const defaultTranscriptionModel = 'gpt-4o-transcribe'
export const defaultTranslationModel = 'gpt-5.3-codex'

export const AllowedLilacModelSchema = z.union([
	ChatRealtimeModelSchema,
	TranscriptionModelSchema,
	TranslationModelSchema
])

export type ChatRealtimeModel = z.infer<typeof ChatRealtimeModelSchema>
export type TranscriptionModel = z.infer<typeof TranscriptionModelSchema>
export type TranslationModel = z.infer<typeof TranslationModelSchema>
