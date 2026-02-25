'use server'

import { z } from 'zod'
import env from '~/env'

const RealtimeSessionSchema = z.object({
	client_secret: z.object({
		expires_at: z.number(),
		value: z.string()
	}),
	expires_at: z.number().optional(),
	id: z.string(),
	model: z.string()
})

export type RealtimeSession = z.infer<typeof RealtimeSessionSchema>

const CreateSessionInputSchema = z.object({
	instructions: z.string().optional(),
	model: z.string().default('gpt-realtime-1.5'),
	voice: z.string().default('verse')
})

export type CreateRealtimeSessionInput = z.input<typeof CreateSessionInputSchema>

export async function createRealtimeSession(
	input?: CreateRealtimeSessionInput
): Promise<RealtimeSession> {
	const { model, voice, instructions } = CreateSessionInputSchema.parse(input ?? {})

	const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
		body: JSON.stringify({
			model,
			voice,
			...(instructions ? { instructions } : {})
		}),
		headers: {
			Authorization: `Bearer ${env.OPENAI_API_KEY}`,
			'Content-Type': 'application/json',
			'OpenAI-Beta': 'realtime=v1'
		},
		method: 'POST'
	})

	if (!response.ok) {
		const message = await response.text()
		throw new Error(message || 'Failed to create realtime session')
	}

	const json = await response.json()
	return RealtimeSessionSchema.parse(json)
}
