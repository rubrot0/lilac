'use client'

import {
	createLilacTestBusEventId,
	type LilacTestBusEvent,
	LilacTestBusEventSchema
} from '@/evals/contracts'

type LilacTestBusListener = (event: LilacTestBusEvent) => void

type LilacTestBusEventInput = {
	[EventType in LilacTestBusEvent['eventType']]: Omit<
		Extract<LilacTestBusEvent, { eventType: EventType }>,
		'eventId' | 'occurredAt'
	>
}[LilacTestBusEvent['eventType']]

type LilacTestBusStore = {
	assistantAudioElement: HTMLAudioElement | null
	eventLog: LilacTestBusEvent[]
	emit: (event: LilacTestBusEventInput) => void
	subscribe: (listener: LilacTestBusListener) => () => void
}

declare global {
	interface Window {
		__lilacTestBus?: LilacTestBusStore
	}
}

function createLilacTestBusStore(): LilacTestBusStore {
	const listenerSet = new Set<LilacTestBusListener>()
	const eventLog: LilacTestBusEvent[] = []

	function emit(event: LilacTestBusEventInput): void {
		const hydratedEvent = LilacTestBusEventSchema.parse({
			...event,
			eventId: createLilacTestBusEventId(),
			occurredAt: Date.now()
		})
		eventLog.push(hydratedEvent)
		listenerSet.forEach(listener => {
			listener(hydratedEvent)
		})
	}

	function subscribe(listener: LilacTestBusListener): () => void {
		listenerSet.add(listener)
		return function unsubscribe(): void {
			listenerSet.delete(listener)
		}
	}

	return {
		assistantAudioElement: null,
		emit,
		eventLog,
		subscribe
	}
}

export function getLilacTestBusStore(): LilacTestBusStore | null {
	if (typeof window === 'undefined') return null
	if (!window.__lilacTestBus) {
		window.__lilacTestBus = createLilacTestBusStore()
	}
	return window.__lilacTestBus
}

export function emitLilacTestBusEvent(event: LilacTestBusEventInput): void {
	getLilacTestBusStore()?.emit(event)
}

export function setLilacTestAssistantAudioElement(audioElement: HTMLAudioElement | null): void {
	const store = getLilacTestBusStore()
	if (!store) return
	store.assistantAudioElement = audioElement
}
