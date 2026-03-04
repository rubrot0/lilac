import { z } from 'zod'
import { isValidLanguageCode, normalizeLanguageCode } from '@/realtime/languageCatalog'
import {
	ChatRealtimeModelSchema,
	defaultChatRealtimeModel,
	defaultTranscriptionModel
} from '@/realtime/modelConfig'

export const LanguageCodeSchema = z
	.string()
	.min(2)
	.max(35)
	.transform(value => normalizeLanguageCode(value))
	.refine(value => isValidLanguageCode(value), {
		message: 'Expected a valid language code (BCP-47 style).'
	})

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
	model: ChatRealtimeModelSchema.default(defaultChatRealtimeModel),
	speechOutputEnabled: z.boolean().default(true),
	turnDelaySeconds: z.number().min(0.2).max(6).default(1.2),
	voice: z.string().default('verse')
})

export const CreateRealtimeClientSecretActionOutputSchema = z.object({
	expiresAt: z.number(),
	value: z.string().min(1)
})

export const CreateTranslateRealtimeClientSecretActionInputSchema = z.object({
	model: ChatRealtimeModelSchema.default(defaultChatRealtimeModel),
	myLanguageCode: LanguageCodeSchema,
	translateToLanguageCode: LanguageCodeSchema
})

export const CreateTranslateRealtimeClientSecretActionOutputSchema = z.object({
	expiresAt: z.number(),
	value: z.string().min(1)
})

export const CreateRealtimeTranscriptionSessionActionInputSchema = z.object({
	myLanguageCode: LanguageCodeSchema,
	translateToLanguageCode: LanguageCodeSchema
})

export const CreateRealtimeTranscriptionSessionActionOutputSchema = z.object({
	expiresAt: z.number(),
	value: z.string().min(1)
})

export const PublishTranslationToolArgumentsSchema = z.object({
	direction: z.enum(['my_to_target', 'target_to_my']),
	sourceLanguageCode: LanguageCodeSchema,
	sourceText: z.string().min(1),
	targetLanguageCode: LanguageCodeSchema,
	translatedText: z.string().min(1)
})

export const RealtimeBaseServerEventSchema = z
	.object({
		type: z.string().min(1)
	})
	.passthrough()

export const RealtimeErrorEventSchema = z
	.object({
		error: z
			.object({
				message: z.string().optional()
			})
			.passthrough()
			.optional(),
		type: z.literal('error')
	})
	.passthrough()

export const InputAudioBufferCommittedEventSchema = z
	.object({
		item_id: z.string(),
		previous_item_id: z.string().nullable().optional(),
		type: z.literal('input_audio_buffer.committed')
	})
	.passthrough()

export const InputAudioBufferSpeechStartedEventSchema = z
	.object({
		type: z.literal('input_audio_buffer.speech_started')
	})
	.passthrough()

export const InputAudioBufferSpeechStoppedEventSchema = z
	.object({
		type: z.literal('input_audio_buffer.speech_stopped')
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

export const SanitizedSubtitleSegmentSchema = z.object({
	itemId: z.string().min(1),
	text: z.string().min(1)
})

export const SystemLeakTextSchema = z
	.array(z.string().min(1))
	.default([
		'context:',
		'likely conversation languages',
		'keep proper nouns',
		'preserve punctuation',
		'no summaries',
		'no commentary'
	])

const ConversationItemContentPartSchema = z
	.object({
		text: z.string().optional(),
		transcript: z.string().optional(),
		type: z.string()
	})
	.passthrough()

export const ConversationItemCreatedEventSchema = z
	.object({
		item: z
			.object({
				content: z.array(ConversationItemContentPartSchema).optional(),
				id: z.string(),
				role: z.string().optional(),
				type: z.string().optional()
			})
			.passthrough(),
		previous_item_id: z.string().nullable().optional(),
		type: z.literal('conversation.item.created')
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

export const ResponseOutputItemDoneEventSchema = z
	.object({
		item: z
			.object({
				arguments: z.string().optional(),
				id: z.string().optional(),
				name: z.string().optional(),
				type: z.string()
			})
			.passthrough(),
		response_id: z.string().optional(),
		type: z.literal('response.output_item.done')
	})
	.passthrough()

export const ResponseCreatedEventSchema = z
	.object({
		response: z
			.object({
				id: z.string().optional(),
				metadata: z.record(z.string(), z.unknown()).nullable().optional()
			})
			.passthrough()
			.optional(),
		type: z.literal('response.created')
	})
	.passthrough()

export const ResponseFunctionCallArgumentsDoneEventSchema = z
	.object({
		arguments: z.string().optional(),
		item: z
			.object({
				arguments: z.string().optional(),
				name: z.string().optional(),
				type: z.string().optional()
			})
			.passthrough()
			.optional(),
		name: z.string().optional(),
		response_id: z.string().optional(),
		type: z.literal('response.function_call_arguments.done')
	})
	.passthrough()

const ResponseDoneFunctionCallItemSchema = z
	.object({
		arguments: z.string().optional(),
		call_id: z.string().optional(),
		id: z.string().optional(),
		name: z.string().optional(),
		type: z.string()
	})
	.passthrough()

export const ResponseDoneEventSchema = z
	.object({
		response: z
			.object({
				id: z.string().optional(),
				metadata: z.record(z.string(), z.unknown()).nullable().optional(),
				output: z.array(ResponseDoneFunctionCallItemSchema).optional(),
				status: z.string().optional(),
				status_details: z.record(z.string(), z.unknown()).nullable().optional()
			})
			.passthrough()
			.optional(),
		response_id: z.string().optional(),
		type: z.literal('response.done')
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

export const defaultInputTranscriptionModel = defaultTranscriptionModel
