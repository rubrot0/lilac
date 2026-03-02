import { z } from 'zod'

import { languageOptions } from '@/realtime/sessionTypes'

const languageCodeValues = languageOptions.map(option => option.code)

const LanguageCodeSchema = z
	.string()
	.min(2)
	.transform(value => value.trim().toLowerCase())

const KnownLanguageCodeSchema = z.enum(languageCodeValues as [string, ...string[]])

const RealtimeClientSecretSchema = z.object({
	expires_at: z.number(),
	value: z.string().min(1)
})

const RealtimeClientSecretResponseSchema = z.object({
	expires_at: z.number(),
	session: z.record(z.string(), z.unknown()).optional(),
	value: z.string().min(1)
})

const RealtimeSessionClientSecretResponseSchema = z.object({
	client_secret: RealtimeClientSecretSchema,
	id: z.string().optional(),
	object: z.string().optional(),
	session: z.record(z.string(), z.unknown()).optional()
})

export const CreateRealtimeClientSecretActionInputSchema = z.object({
	instructions: z.string().max(12000).optional(),
	model: z.string().default('gpt-realtime'),
	turnDelaySeconds: z.number().min(0.2).max(6).default(1.2),
	voice: z.string().default('verse')
})

export const CreateRealtimeClientSecretActionOutputSchema = z.object({
	expiresAt: z.number(),
	value: z.string().min(1)
})

export const CreateRealtimeTranscriptionSessionActionInputSchema = z.object({
	languageHint: LanguageCodeSchema.optional(),
	model: z.string().default('gpt-4o-transcribe'),
	turnDelaySeconds: z.number().min(0.2).max(6).default(1.2)
})

export const CreateRealtimeTranscriptionSessionActionOutputSchema = z.object({
	expiresAt: z.number(),
	value: z.string().min(1)
})

export const TranslationContextEntrySchema = z.object({
	direction: z.enum(['primary_to_secondary', 'secondary_to_primary', 'to_target']),
	sourceLanguageCode: LanguageCodeSchema,
	sourceText: z.string().min(1),
	targetLanguageCode: LanguageCodeSchema,
	translatedText: z.string().min(1)
})

const TranslateModeSettingsSchema = z.object({
	mode: z.literal('translate'),
	primaryLanguageCode: KnownLanguageCodeSchema,
	secondaryLanguageCode: KnownLanguageCodeSchema
})

const TranscribeModeSettingsSchema = z.object({
	mode: z.literal('transcribe'),
	targetLanguageCode: KnownLanguageCodeSchema
})

export const TranslateUtteranceActionInputSchema = z.object({
	context: z.array(TranslationContextEntrySchema).max(16).default([]),
	model: z.string().default('gpt-4.1-mini'),
	settings: z.union([TranslateModeSettingsSchema, TranscribeModeSettingsSchema]),
	utteranceText: z.string().min(1).max(5000)
})

export const TranslateUtteranceActionOutputSchema = z.object({
	detectedSourceLanguageCode: LanguageCodeSchema,
	direction: z.enum(['primary_to_secondary', 'secondary_to_primary', 'to_target']),
	targetLanguageCode: LanguageCodeSchema,
	translatedText: z.string().min(1)
})

export const CompactTranslationContextActionInputSchema = z.object({
	context: z.array(TranslationContextEntrySchema).max(200),
	model: z.string().default('gpt-4.1-mini')
})

export const CompactTranslationContextActionOutputSchema = z.object({
	compactedContext: z.array(TranslationContextEntrySchema),
	performedCompaction: z.boolean()
})

export const RealtimeBaseServerEventSchema = z
	.object({
		type: z.string().min(1)
	})
	.passthrough()

export const InputAudioBufferCommittedEventSchema = z
	.object({
		item_id: z.string(),
		type: z.literal('input_audio_buffer.committed')
	})
	.passthrough()

export const InputAudioTranscriptionDeltaEventSchema = z
	.object({
		delta: z.string(),
		item_id: z.string(),
		type: z.literal('conversation.item.input_audio_transcription.delta')
	})
	.passthrough()

export const InputAudioTranscriptionCompletedEventSchema = z
	.object({
		item_id: z.string(),
		transcript: z.string(),
		type: z.literal('conversation.item.input_audio_transcription.completed')
	})
	.passthrough()

export const ResponseOutputTextDeltaEventSchema = z
	.object({
		delta: z.string(),
		item_id: z.string().optional(),
		response_id: z.string().optional(),
		type: z.literal('response.output_text.delta')
	})
	.passthrough()

export const ResponseOutputTextDoneEventSchema = z
	.object({
		item_id: z.string().optional(),
		response_id: z.string().optional(),
		text: z.string().optional(),
		type: z.literal('response.output_text.done')
	})
	.passthrough()

export const ResponseOutputAudioTranscriptDeltaEventSchema = z
	.object({
		delta: z.string(),
		item_id: z.string().optional(),
		response_id: z.string().optional(),
		type: z.literal('response.output_audio_transcript.delta')
	})
	.passthrough()

export const ResponseDoneEventSchema = z
	.object({
		response_id: z.string().optional(),
		type: z.literal('response.done')
	})
	.passthrough()

export const ResponseOutputItemAddedEventSchema = z
	.object({
		item: z
			.object({
				id: z.string()
			})
			.passthrough(),
		response_id: z.string().optional(),
		type: z.literal('response.output_item.added')
	})
	.passthrough()

export function parseClientSecretResponse(value: unknown): { expiresAt: number; value: string } {
	const directSecret = RealtimeClientSecretResponseSchema.safeParse(value)
	if (directSecret.success) {
		return {
			expiresAt: directSecret.data.expires_at,
			value: directSecret.data.value
		}
	}

	const nestedSecret = RealtimeSessionClientSecretResponseSchema.safeParse(value)
	if (nestedSecret.success) {
		return {
			expiresAt: nestedSecret.data.client_secret.expires_at,
			value: nestedSecret.data.client_secret.value
		}
	}

	throw new Error('OpenAI response did not include an ephemeral client secret')
}
