'use client'

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState
} from 'react'

import { ChatRealtimeClient, type ChatTranscriptPatch } from '@/realtime/chatRealtimeClient'
import { normalizeLanguageCode, resolveLanguageCode } from '@/realtime/languageCatalog'
import {
	type LiveTranslateDraftPatch,
	LiveTranslateRealtimeClient,
	type LiveTranslateResultPatch,
	type TranslateDraftInputPayload,
	type TranslateInputPayload
} from '@/realtime/liveTranslateRealtimeClient'
import { defaultChatRealtimeModel } from '@/realtime/modelConfig'
import { SystemLeakTextSchema } from '@/realtime/schemas'
import type {
	ChatOutputSettings,
	ChatTranscriptMessage,
	ConnectionHealthState,
	GlobalAudioInputSettings,
	LilacMode,
	LiveSubtitleState,
	ModeConnectionState,
	TranslateSettings,
	UtteranceCard,
	UtteranceDirection
} from '@/realtime/sessionTypes'
import {
	type SubtitleFinalPatch,
	SubtitleTranscriptionClient
} from '@/realtime/subtitleTranscriptionClient'

const defaultChatInstructions =
	'You are Lilac. Help users communicate across languages. Keep answers concise, faithful, and practical.'

const defaultTranslateSettings: TranslateSettings = {
	myLanguageCode: 'en',
	translateToLanguageCode: 'es'
}

const defaultGlobalAudioInputSettings: GlobalAudioInputSettings = {
	voiceInputEnabled: true
}

const defaultChatOutputSettings: ChatOutputSettings = {
	speechOutputEnabled: true
}

const defaultLiveSubtitleState: LiveSubtitleState = {
	activeSegmentId: null,
	isListening: false,
	text: '',
	updatedAt: 0
}

const defaultConnectionHealthState: ConnectionHealthState = {
	isReconnecting: false,
	lastErrorAt: null,
	subtitleConnected: false,
	translateConnected: false
}

const storageKeys = {
	chatInstructions: 'lilac.chat.instructions',
	chatSpeechOutputEnabled: 'lilac.chat.speechOutputEnabled',
	chatTurnDelaySeconds: 'lilac.chat.turnDelaySeconds',
	mode: 'lilac.mode',
	translateMyLanguage: 'lilac.translate.myLanguageCode',
	translatePrimaryLanguageLegacy: 'lilac.translate.primaryLanguageCode',
	translateSecondaryLanguageLegacy: 'lilac.translate.secondaryLanguageCode',
	translateToLanguage: 'lilac.translate.translateToLanguageCode',
	voiceInputEnabled: 'lilac.global.voiceInputEnabled'
} as const

type RuntimeChannel = 'chat' | 'subtitle' | 'translate'
type ChannelConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

type PendingTranslateInput =
	| (TranslateInputPayload & {
			requestKind: 'final'
	  })
	| (TranslateDraftInputPayload & {
			requestKind: 'draft'
	  })

const reconnectStatusGraceMilliseconds = 1500
const subtitleDedupRoundedTimeWindowMilliseconds = 700
const draftTranslateDebounceMilliseconds = 300
const finalTranslateLowConfidenceThreshold = 0.6
const finalTranslateLowConfidenceDelayMilliseconds = 280
const finalTranslateSilenceDelayMilliseconds = 1200
const audioUtteranceReuseThresholdMilliseconds = 1200
const minimumDraftTextLength = 2
const minimumDraftTextDeltaLength = 4
const isTranslateStreamingV2Enabled =
	process.env.NEXT_PUBLIC_LILAC_TRANSLATE_STREAMING_V2 !== 'false'
const systemLeakMatcherList = SystemLeakTextSchema.parse(undefined).map(matcher =>
	matcher.toLowerCase()
)

function normalizeTurnDelaySeconds(value: unknown): number {
	const parsedValue = typeof value === 'number' ? value : Number.parseFloat(String(value))
	if (!Number.isFinite(parsedValue)) return 1.2
	const clampedValue = Math.min(6, Math.max(0.2, parsedValue))
	return Math.round(clampedValue * 10) / 10
}

function parseStoredBoolean(value: null | string, fallbackValue: boolean): boolean {
	if (value === 'true') return true
	if (value === 'false') return false
	return fallbackValue
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim()
}

function getChatRoleSortValue(role: 'assistant' | 'user'): number {
	switch (role) {
		case 'user':
			return 0
		case 'assistant':
			return 1
		default:
			return 2
	}
}

function shouldDropSubtitleText(value: string): boolean {
	const normalizedValue = normalizeWhitespace(value).toLowerCase()
	if (!normalizedValue) return true
	for (const matcher of systemLeakMatcherList) {
		if (normalizedValue.includes(matcher)) return true
	}
	if (normalizedValue === 'context') return true
	if (normalizedValue === 'context:') return true
	return false
}

function mergeUtteranceText(existingText: string, nextChunkText: string): string {
	const normalizedExistingText = normalizeWhitespace(existingText)
	const normalizedChunkText = normalizeWhitespace(nextChunkText)
	if (!normalizedChunkText) return normalizedExistingText
	if (!normalizedExistingText) return normalizedChunkText
	if (normalizedExistingText.toLowerCase().endsWith(normalizedChunkText.toLowerCase())) {
		return normalizedExistingText
	}
	if (normalizedChunkText.toLowerCase().startsWith(normalizedExistingText.toLowerCase())) {
		return normalizedChunkText
	}
	return `${normalizedExistingText} ${normalizedChunkText}`
}

function sanitizeTranslateSettings(input: Partial<TranslateSettings> | null): TranslateSettings {
	const myLanguageCode = resolveLanguageCode(
		input?.myLanguageCode ?? '',
		defaultTranslateSettings.myLanguageCode
	)
	let translateToLanguageCode = resolveLanguageCode(
		input?.translateToLanguageCode ?? '',
		defaultTranslateSettings.translateToLanguageCode
	)
	if (myLanguageCode === translateToLanguageCode) {
		translateToLanguageCode =
			myLanguageCode === defaultTranslateSettings.myLanguageCode
				? defaultTranslateSettings.translateToLanguageCode
				: defaultTranslateSettings.myLanguageCode
	}
	return {
		myLanguageCode,
		translateToLanguageCode
	}
}

function createClientItemId(prefix: string): string {
	const randomSegment = crypto.randomUUID().replaceAll('-', '').slice(0, 24)
	return `${prefix}_${randomSegment}`
}

function createEmptyUtteranceCard(
	itemId: string,
	inputOrigin: 'audio' | 'text',
	translateSettings: TranslateSettings,
	utteranceSequence: number
): UtteranceCard {
	return {
		createdAt: Date.now(),
		direction: 'my_to_target',
		draftSequence: 0,
		draftTranslatedText: '',
		id: itemId,
		inputOrigin,
		renderState: 'listening',
		sourceItemId: itemId,
		sourceLanguageCode: translateSettings.myLanguageCode,
		sourceText: '',
		status: 'streaming',
		targetLanguageCode: translateSettings.translateToLanguageCode,
		translatedText: '',
		utteranceSequence
	}
}

function insertCardByPreviousItemId(
	cardList: UtteranceCard[],
	nextCard: UtteranceCard,
	previousItemId?: null | string
): UtteranceCard[] {
	const filteredCards = cardList.filter(card => card.id !== nextCard.id)
	if (!previousItemId) return [...filteredCards, nextCard]
	const previousIndex = filteredCards.findIndex(card => card.id === previousItemId)
	if (previousIndex === -1) return [...filteredCards, nextCard]
	return [
		...filteredCards.slice(0, previousIndex + 1),
		nextCard,
		...filteredCards.slice(previousIndex + 1)
	]
}

function upsertChatTranscript(
	existingList: ChatTranscriptMessage[],
	patch: ChatTranscriptPatch,
	nextSequenceNumber: number
): { list: ChatTranscriptMessage[]; nextSequenceNumber: number } {
	const existingIndex = existingList.findIndex(item => item.id === patch.id)
	const existingItem = existingIndex >= 0 ? existingList[existingIndex] : null

	if (
		existingItem?.role === 'assistant' &&
		existingItem.source === 'response_output_text' &&
		patch.source === 'response_output_audio_transcript'
	) {
		return {
			list: existingList,
			nextSequenceNumber
		}
	}

	const updatedText =
		typeof patch.replaceText === 'string'
			? patch.replaceText
			: `${existingItem?.text ?? ''}${patch.appendText ?? ''}`

	const slotOrder =
		typeof patch.slotOrder === 'number'
			? patch.slotOrder
			: typeof existingItem?.slotOrder === 'number'
				? existingItem.slotOrder
				: undefined
	const slotId =
		typeof patch.slotId === 'string'
			? patch.slotId
			: typeof existingItem?.slotId === 'string'
				? existingItem.slotId
				: undefined
	const roleSortValue = getChatRoleSortValue(patch.role)
	const slotBasedSequence =
		typeof slotOrder === 'number' ? slotOrder * 10 + roleSortValue : undefined
	const nextItem: ChatTranscriptMessage = {
		clientSequence:
			existingItem?.clientSequence ??
			(typeof slotBasedSequence === 'number' ? slotBasedSequence : nextSequenceNumber),
		createdAt: existingItem?.createdAt ?? Date.now(),
		id: patch.id,
		role: patch.role,
		...(typeof slotId === 'string' ? { slotId } : {}),
		...(typeof slotOrder === 'number' ? { slotOrder } : {}),
		source: patch.source,
		status: patch.status ?? existingItem?.status ?? 'streaming',
		text: updatedText
	}

	if (typeof slotBasedSequence === 'number' && nextItem.clientSequence !== slotBasedSequence) {
		nextItem.clientSequence = slotBasedSequence
	}

	if (existingIndex === -1) {
		const nextList = [...existingList, nextItem].sort(
			(left, right) =>
				(left.slotOrder ?? Number.MAX_SAFE_INTEGER) - (right.slotOrder ?? Number.MAX_SAFE_INTEGER) ||
				getChatRoleSortValue(left.role) - getChatRoleSortValue(right.role) ||
				left.clientSequence - right.clientSequence ||
				left.createdAt - right.createdAt
		)
		return {
			list: nextList,
			nextSequenceNumber: nextSequenceNumber + 1
		}
	}

	const nextList = existingList.slice()
	nextList[existingIndex] = nextItem
	nextList.sort(
		(left, right) =>
			(left.slotOrder ?? Number.MAX_SAFE_INTEGER) - (right.slotOrder ?? Number.MAX_SAFE_INTEGER) ||
			getChatRoleSortValue(left.role) - getChatRoleSortValue(right.role) ||
			left.clientSequence - right.clientSequence ||
			left.createdAt - right.createdAt
	)
	return {
		list: nextList,
		nextSequenceNumber
	}
}

function applyTranslateResultPatch(
	cardList: UtteranceCard[],
	patch: LiveTranslateResultPatch,
	translateSettings: TranslateSettings,
	nextUtteranceSequence: number
): UtteranceCard[] {
	const existingCard = cardList.find(card => card.id === patch.itemId) ?? null
	const baseCard = existingCard
		? (() => {
				const { errorMessage: _errorMessage, responseId: _responseId, ...restCard } = existingCard
				return restCard
			})()
		: createEmptyUtteranceCard(
				patch.itemId,
				patch.inputOrigin,
				translateSettings,
				nextUtteranceSequence
			)

	const normalizedSourceText = normalizeWhitespace(patch.sourceText)
	const safeSourceText =
		normalizedSourceText && !shouldDropSubtitleText(normalizedSourceText)
			? normalizedSourceText
			: (existingCard?.sourceText ?? '')

	const nextCard: UtteranceCard = {
		...baseCard,
		direction: patch.direction,
		inputOrigin: patch.inputOrigin,
		renderState: patch.status === 'error' ? 'error' : 'final',
		sourceLanguageCode: normalizeLanguageCode(patch.sourceLanguageCode),
		sourceText: safeSourceText,
		status: patch.status,
		targetLanguageCode: normalizeLanguageCode(patch.targetLanguageCode),
		translatedText: patch.translatedText,
		...(patch.status === 'final'
			? { draftTranslatedText: patch.translatedText, lastDraftAt: Date.now() }
			: typeof baseCard.draftTranslatedText === 'string'
				? { draftTranslatedText: baseCard.draftTranslatedText }
				: {}),
		...(patch.status === 'error' ? { errorMessage: patch.translatedText } : {}),
		...(patch.responseId ? { responseId: patch.responseId } : {})
	}

	return insertCardByPreviousItemId(cardList, nextCard)
}

function applyTranslateDraftPatch(
	cardList: UtteranceCard[],
	patch: LiveTranslateDraftPatch,
	translateSettings: TranslateSettings,
	nextUtteranceSequence: number
): UtteranceCard[] {
	const existingCard = cardList.find(card => card.id === patch.itemId) ?? null
	if (
		existingCard &&
		(existingCard.renderState === 'final' || existingCard.renderState === 'error')
	) {
		return cardList
	}
	if (existingCard && patch.draftSequence < existingCard.draftSequence) {
		return cardList
	}

	const baseCard = existingCard
		? { ...existingCard }
		: createEmptyUtteranceCard(
				patch.itemId,
				patch.inputOrigin,
				translateSettings,
				nextUtteranceSequence
			)
	const nextCard: UtteranceCard = {
		...baseCard,
		draftSequence: patch.draftSequence,
		draftTranslatedText: patch.translatedText,
		inputOrigin: patch.inputOrigin,
		lastDraftAt: Date.now(),
		renderState: 'draft',
		status: 'draft',
		...(patch.responseId ? { responseId: patch.responseId } : {})
	}
	return insertCardByPreviousItemId(cardList, nextCard)
}

function getDirectionColorClass(direction: UtteranceDirection): string {
	switch (direction) {
		case 'my_to_target':
			return 'var(--lilac-direction-primary)'
		case 'target_to_my':
			return 'var(--lilac-direction-secondary)'
		default:
			return 'var(--lilac-ink-muted)'
	}
}

function mapChatConnectionState(state: ChannelConnectionState): ModeConnectionState {
	switch (state) {
		case 'connected':
			return 'connected'
		case 'connecting':
			return 'connecting'
		case 'error':
			return 'error'
		default:
			return 'idle'
	}
}

function mapTranslateConnectionState(
	translateConnectionState: ChannelConnectionState,
	subtitleConnectionState: ChannelConnectionState
): ModeConnectionState {
	if (translateConnectionState === 'error' || subtitleConnectionState === 'error') return 'error'
	if (translateConnectionState === 'connected' && subtitleConnectionState === 'connected')
		return 'connected'
	if (translateConnectionState === 'connecting' || subtitleConnectionState === 'connecting') {
		return 'connecting'
	}
	if (translateConnectionState === 'connected' || subtitleConnectionState === 'connected') {
		return 'connecting'
	}
	return 'idle'
}

function calculateReconnectDelay(attemptNumber: number): number {
	const baseDelayMilliseconds = Math.min(8000, 1000 * 2 ** Math.max(0, attemptNumber - 1))
	const jitterMilliseconds = Math.floor(Math.random() * 250)
	return baseDelayMilliseconds + jitterMilliseconds
}

type LilacModeRuntimeContextValue = {
	chatInstructions: string
	chatSpeechOutputEnabled: boolean
	chatTranscripts: ChatTranscriptMessage[]
	chatTurnDelaySeconds: number
	connectionState: ModeConnectionState
	errorMessage: null | string
	getDirectionColor: (direction: UtteranceDirection) => string
	liveSubtitleState: LiveSubtitleState
	mode: LilacMode
	remoteAudioStream: MediaStream | null
	setChatInstructions: (instructions: string) => void
	setChatSpeechOutputEnabled: (speechOutputEnabled: boolean) => void
	setChatTurnDelaySeconds: (seconds: number) => void
	setMode: (mode: LilacMode) => void
	setTranslateSettings: (nextSettings: TranslateSettings) => void
	setVoiceInputEnabled: (voiceInputEnabled: boolean) => void
	statusMessage: null | string
	submitChatTextInput: (text: string) => void
	submitTranslateTextInput: (text: string) => void
	translateCards: UtteranceCard[]
	translateSettings: TranslateSettings
	voiceInputEnabled: boolean
}

const LilacModeRuntimeContext = createContext<LilacModeRuntimeContextValue | null>(null)

export function LilacModeRuntimeProvider({ children }: { children: ReactNode }) {
	const [mode, setModeState] = useState<LilacMode>('chat')
	const [connectionState, setConnectionState] = useState<ModeConnectionState>('idle')
	const [errorMessage, setErrorMessage] = useState<null | string>(null)
	const [statusMessage, setStatusMessage] = useState<null | string>(null)
	const [chatInstructions, setChatInstructionsState] = useState(defaultChatInstructions)
	const [chatTurnDelaySeconds, setChatTurnDelaySecondsState] = useState(1.2)
	const [chatTranscripts, setChatTranscripts] = useState<ChatTranscriptMessage[]>([])
	const [translateSettings, setTranslateSettingsState] =
		useState<TranslateSettings>(defaultTranslateSettings)
	const [translateCards, setTranslateCards] = useState<UtteranceCard[]>([])
	const [liveSubtitleState, setLiveSubtitleState] =
		useState<LiveSubtitleState>(defaultLiveSubtitleState)
	const [globalAudioInputSettings, setGlobalAudioInputSettings] = useState<GlobalAudioInputSettings>(
		defaultGlobalAudioInputSettings
	)
	const [chatOutputSettings, setChatOutputSettings] =
		useState<ChatOutputSettings>(defaultChatOutputSettings)
	const [connectionHealth, setConnectionHealth] = useState<ConnectionHealthState>(
		defaultConnectionHealthState
	)
	const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null)
	const [chatChannelState, setChatChannelState] = useState<ChannelConnectionState>('disconnected')
	const [translateChannelState, setTranslateChannelState] =
		useState<ChannelConnectionState>('disconnected')
	const [subtitleChannelState, setSubtitleChannelState] =
		useState<ChannelConnectionState>('disconnected')
	const [isOnline, setIsOnline] = useState(true)
	const [isHydrated, setIsHydrated] = useState(false)

	const chatClientRef = useRef<ChatRealtimeClient | null>(null)
	const liveTranslateClientRef = useRef<LiveTranslateRealtimeClient | null>(null)
	const subtitleClientRef = useRef<SubtitleTranscriptionClient | null>(null)

	const chatInstructionsRef = useRef(chatInstructions)
	const chatTurnDelaySecondsRef = useRef(chatTurnDelaySeconds)
	const translateSettingsRef = useRef(translateSettings)
	const voiceInputEnabledRef = useRef(globalAudioInputSettings.voiceInputEnabled)
	const chatSpeechOutputEnabledRef = useRef(chatOutputSettings.speechOutputEnabled)
	const modeRef = useRef<LilacMode>(mode)
	const isHydratedRef = useRef(false)
	const isOnlineRef = useRef(true)

	const pendingTranslateInputQueueRef = useRef<PendingTranslateInput[]>([])
	const chatTranscriptSequenceRef = useRef(1)
	const subtitleDedupKeyTimestampByKeyRef = useRef<Map<string, number>>(new Map())
	const subtitleSegmentTextByItemIdRef = useRef<Map<string, string>>(new Map())
	const subtitleSourceTextByItemIdRef = useRef<Map<string, string>>(new Map())
	const subtitlePreviousItemIdByItemIdRef = useRef<Map<string, null | string>>(new Map())
	const subtitleUtteranceIdBySegmentItemIdRef = useRef<Map<string, string>>(new Map())
	const subtitlePreviousUtteranceIdByUtteranceIdRef = useRef<Map<string, null | string>>(new Map())
	const subtitleLatestConfidenceByItemIdRef = useRef<Map<string, number>>(new Map())
	const subtitleCommittedAtByItemIdRef = useRef<Map<string, number>>(new Map())
	const activeAudioUtteranceRef = useRef<null | { id: string; updatedAt: number }>(null)
	const lastAudioUtteranceIdRef = useRef<null | string>(null)
	const translateDraftSequenceByItemIdRef = useRef<Map<string, number>>(new Map())
	const translateLastDraftSourceTextByItemIdRef = useRef<Map<string, string>>(new Map())
	const translateDraftScheduleTimerByItemIdRef = useRef<Map<string, number>>(new Map())
	const translateFinalScheduleTimerByItemIdRef = useRef<Map<string, number>>(new Map())
	const translateUtteranceSequenceRef = useRef(1)
	const reconnectTimerByChannelRef = useRef<Partial<Record<RuntimeChannel, number>>>({})
	const reconnectStatusTimerRef = useRef<null | number>(null)
	const scheduleReconnectRef = useRef<(channel: RuntimeChannel) => void>(() => {})
	const reconnectAttemptByChannelRef = useRef<Record<RuntimeChannel, number>>({
		chat: 0,
		subtitle: 0,
		translate: 0
	})
	const hasSeenConnectedStateByModeRef = useRef<Record<LilacMode, boolean>>({
		chat: false,
		translate: false
	})
	const intentionalStopByChannelRef = useRef<Record<RuntimeChannel, boolean>>({
		chat: false,
		subtitle: false,
		translate: false
	})

	const clearReconnectTimer = useCallback((channel: RuntimeChannel) => {
		const timerId = reconnectTimerByChannelRef.current[channel]
		if (typeof timerId !== 'number') return
		window.clearTimeout(timerId)
		delete reconnectTimerByChannelRef.current[channel]
	}, [])

	const clearTranslateDraftTimerByItemId = useCallback((itemId: string) => {
		const timerId = translateDraftScheduleTimerByItemIdRef.current.get(itemId)
		if (typeof timerId !== 'number') return
		window.clearTimeout(timerId)
		translateDraftScheduleTimerByItemIdRef.current.delete(itemId)
	}, [])

	const clearTranslateFinalTimerByItemId = useCallback((itemId: string) => {
		const timerId = translateFinalScheduleTimerByItemIdRef.current.get(itemId)
		if (typeof timerId !== 'number') return
		window.clearTimeout(timerId)
		translateFinalScheduleTimerByItemIdRef.current.delete(itemId)
	}, [])

	const clearAllTranslateStreamingTimers = useCallback(() => {
		translateDraftScheduleTimerByItemIdRef.current.forEach(timerId => {
			window.clearTimeout(timerId)
		})
		translateFinalScheduleTimerByItemIdRef.current.forEach(timerId => {
			window.clearTimeout(timerId)
		})
		translateDraftScheduleTimerByItemIdRef.current.clear()
		translateFinalScheduleTimerByItemIdRef.current.clear()
	}, [])

	const stopChatClient = useCallback(() => {
		intentionalStopByChannelRef.current.chat = true
		chatClientRef.current?.stop()
		chatClientRef.current = null
		setChatChannelState('disconnected')
		queueMicrotask(() => {
			intentionalStopByChannelRef.current.chat = false
		})
	}, [])

	const stopTranslateClient = useCallback(() => {
		intentionalStopByChannelRef.current.translate = true
		liveTranslateClientRef.current?.stop()
		liveTranslateClientRef.current = null
		setTranslateChannelState('disconnected')
		queueMicrotask(() => {
			intentionalStopByChannelRef.current.translate = false
		})
	}, [])

	const stopSubtitleClient = useCallback(() => {
		intentionalStopByChannelRef.current.subtitle = true
		void subtitleClientRef.current?.stop()
		subtitleClientRef.current = null
		clearAllTranslateStreamingTimers()
		subtitleSegmentTextByItemIdRef.current.clear()
		subtitleSourceTextByItemIdRef.current.clear()
		subtitlePreviousItemIdByItemIdRef.current.clear()
		subtitleUtteranceIdBySegmentItemIdRef.current.clear()
		subtitlePreviousUtteranceIdByUtteranceIdRef.current.clear()
		subtitleLatestConfidenceByItemIdRef.current.clear()
		subtitleCommittedAtByItemIdRef.current.clear()
		activeAudioUtteranceRef.current = null
		lastAudioUtteranceIdRef.current = null
		translateDraftSequenceByItemIdRef.current.clear()
		translateLastDraftSourceTextByItemIdRef.current.clear()
		setSubtitleChannelState('disconnected')
		setLiveSubtitleState(previousState => ({
			...previousState,
			activeSegmentId: null,
			isListening: false,
			text: '',
			updatedAt: Date.now()
		}))
		queueMicrotask(() => {
			intentionalStopByChannelRef.current.subtitle = false
		})
	}, [clearAllTranslateStreamingTimers])

	const stopAllClients = useCallback(() => {
		stopChatClient()
		stopTranslateClient()
		stopSubtitleClient()
		setRemoteAudioStream(null)
	}, [stopChatClient, stopSubtitleClient, stopTranslateClient])

	const clearAllInMemoryState = useCallback(() => {
		setChatTranscripts([])
		setTranslateCards([])
		setLiveSubtitleState(defaultLiveSubtitleState)
		subtitleDedupKeyTimestampByKeyRef.current.clear()
		subtitleSegmentTextByItemIdRef.current.clear()
		subtitleSourceTextByItemIdRef.current.clear()
		subtitlePreviousItemIdByItemIdRef.current.clear()
		subtitleUtteranceIdBySegmentItemIdRef.current.clear()
		subtitlePreviousUtteranceIdByUtteranceIdRef.current.clear()
		subtitleLatestConfidenceByItemIdRef.current.clear()
		subtitleCommittedAtByItemIdRef.current.clear()
		activeAudioUtteranceRef.current = null
		lastAudioUtteranceIdRef.current = null
		translateDraftSequenceByItemIdRef.current.clear()
		translateLastDraftSourceTextByItemIdRef.current.clear()
		translateUtteranceSequenceRef.current = 1
		chatTranscriptSequenceRef.current = 1
		clearAllTranslateStreamingTimers()
		pendingTranslateInputQueueRef.current = []
	}, [clearAllTranslateStreamingTimers])

	const shouldRunChannelForMode = useCallback(
		(channel: RuntimeChannel, activeMode: LilacMode): boolean => {
			switch (activeMode) {
				case 'chat':
					return channel === 'chat'
				case 'translate':
					return channel === 'subtitle' || channel === 'translate'
				default:
					return false
			}
		},
		[]
	)

	const flushPendingTranslateInputs = useCallback(() => {
		const translateClient = liveTranslateClientRef.current
		if (!translateClient || !translateClient.isConnected()) return
		while (pendingTranslateInputQueueRef.current.length > 0) {
			const nextInput = pendingTranslateInputQueueRef.current.shift()
			if (!nextInput) continue
			switch (nextInput.requestKind) {
				case 'draft':
					translateClient.submitDraftInput(nextInput)
					break
				case 'final':
					translateClient.submitFinalInput(nextInput)
					break
				default:
					break
			}
		}
	}, [])

	const enqueueTranslateInput = useCallback(
		(input: PendingTranslateInput) => {
			const existingIndex = pendingTranslateInputQueueRef.current.findIndex(
				queuedInput =>
					queuedInput.itemId === input.itemId && queuedInput.requestKind === input.requestKind
			)
			if (existingIndex >= 0) {
				const existingInput = pendingTranslateInputQueueRef.current[existingIndex]
				if (
					input.requestKind === 'draft' &&
					existingInput?.requestKind === 'draft' &&
					input.draftSequence < existingInput.draftSequence
				) {
					flushPendingTranslateInputs()
					return
				}
				pendingTranslateInputQueueRef.current[existingIndex] = input
				flushPendingTranslateInputs()
				return
			}
			pendingTranslateInputQueueRef.current.push(input)
			flushPendingTranslateInputs()
		},
		[flushPendingTranslateInputs]
	)

	const resolveAudioUtterance = useCallback(
		(
			segmentItemId: string,
			previousSegmentItemId?: null | string
		): { id: string; previousId: null | string } => {
			const existingUtteranceId = subtitleUtteranceIdBySegmentItemIdRef.current.get(segmentItemId)
			if (existingUtteranceId) {
				return {
					id: existingUtteranceId,
					previousId:
						subtitlePreviousUtteranceIdByUtteranceIdRef.current.get(existingUtteranceId) ?? null
				}
			}

			const now = Date.now()
			const activeUtterance = activeAudioUtteranceRef.current
			const mappedPreviousUtteranceId = previousSegmentItemId
				? (subtitleUtteranceIdBySegmentItemIdRef.current.get(previousSegmentItemId) ?? null)
				: null
			const shouldReuseActiveUtterance =
				activeUtterance !== null &&
				now - activeUtterance.updatedAt <= audioUtteranceReuseThresholdMilliseconds &&
				(!mappedPreviousUtteranceId || mappedPreviousUtteranceId === activeUtterance.id)

			if (shouldReuseActiveUtterance && activeUtterance) {
				subtitleUtteranceIdBySegmentItemIdRef.current.set(segmentItemId, activeUtterance.id)
				return {
					id: activeUtterance.id,
					previousId: subtitlePreviousUtteranceIdByUtteranceIdRef.current.get(activeUtterance.id) ?? null
				}
			}

			const utteranceId = createClientItemId('audio_utterance')
			const previousUtteranceId = mappedPreviousUtteranceId ?? lastAudioUtteranceIdRef.current ?? null
			subtitleUtteranceIdBySegmentItemIdRef.current.set(segmentItemId, utteranceId)
			subtitlePreviousUtteranceIdByUtteranceIdRef.current.set(utteranceId, previousUtteranceId)
			lastAudioUtteranceIdRef.current = utteranceId
			activeAudioUtteranceRef.current = {
				id: utteranceId,
				updatedAt: now
			}
			return {
				id: utteranceId,
				previousId: previousUtteranceId
			}
		},
		[]
	)

	const upsertSubtitleCard = useCallback(
		(itemId: string, previousItemId: null | string | undefined, sourceText: string): void => {
			const normalizedText = normalizeWhitespace(sourceText)
			if (!normalizedText) return
			setTranslateCards(previousCards => {
				const existingCardIndex = previousCards.findIndex(card => card.id === itemId)
				if (existingCardIndex === -1) {
					const nextCard: UtteranceCard = {
						...createEmptyUtteranceCard(
							itemId,
							'audio',
							translateSettingsRef.current,
							translateUtteranceSequenceRef.current
						),
						sourceLanguageCode: translateSettingsRef.current.myLanguageCode,
						sourceText: normalizedText,
						status: 'streaming'
					}
					translateUtteranceSequenceRef.current += 1
					const fallbackPreviousItemId =
						previousCards.length > 0 ? (previousCards[previousCards.length - 1]?.id ?? null) : null
					return insertCardByPreviousItemId(
						previousCards,
						nextCard,
						previousItemId ?? fallbackPreviousItemId
					)
				}
				const nextCardList = previousCards.slice()
				const existingCard = nextCardList[existingCardIndex]
				if (
					!existingCard ||
					existingCard.renderState === 'final' ||
					existingCard.renderState === 'error'
				)
					return previousCards
				nextCardList[existingCardIndex] = {
					...existingCard,
					sourceText: normalizedText,
					status: existingCard.renderState === 'draft' ? 'draft' : 'streaming'
				}
				return nextCardList
			})
		},
		[]
	)

	const scheduleDraftTranslateForItem = useCallback(
		(itemId: string, inputOrigin: 'audio' | 'text') => {
			if (!isTranslateStreamingV2Enabled) return
			clearTranslateDraftTimerByItemId(itemId)
			const timerId = window.setTimeout(() => {
				translateDraftScheduleTimerByItemIdRef.current.delete(itemId)
				const latestSourceText = normalizeWhitespace(
					subtitleSourceTextByItemIdRef.current.get(itemId) ?? ''
				)
				if (!latestSourceText || latestSourceText.length < minimumDraftTextLength) return
				const lastDraftSourceText = translateLastDraftSourceTextByItemIdRef.current.get(itemId) ?? ''
				if (latestSourceText === lastDraftSourceText) return
				if (
					lastDraftSourceText.length > 0 &&
					latestSourceText.length - lastDraftSourceText.length < minimumDraftTextDeltaLength
				) {
					return
				}
				const nextDraftSequence = (translateDraftSequenceByItemIdRef.current.get(itemId) ?? 0) + 1
				translateDraftSequenceByItemIdRef.current.set(itemId, nextDraftSequence)
				translateLastDraftSourceTextByItemIdRef.current.set(itemId, latestSourceText)
				enqueueTranslateInput({
					draftSequence: nextDraftSequence,
					inputOrigin,
					itemId,
					requestKind: 'draft',
					text: latestSourceText
				})
			}, draftTranslateDebounceMilliseconds)
			translateDraftScheduleTimerByItemIdRef.current.set(itemId, timerId)
		},
		[clearTranslateDraftTimerByItemId, enqueueTranslateInput]
	)

	const scheduleFinalTranslateForItem = useCallback(
		(itemId: string, inputOrigin: 'audio' | 'text') => {
			clearTranslateFinalTimerByItemId(itemId)
			const confidence = subtitleLatestConfidenceByItemIdRef.current.get(itemId)
			const lowConfidenceDelayMilliseconds =
				typeof confidence === 'number' && confidence < finalTranslateLowConfidenceThreshold
					? finalTranslateLowConfidenceDelayMilliseconds
					: 0
			const delayMilliseconds = finalTranslateSilenceDelayMilliseconds + lowConfidenceDelayMilliseconds
			const timerId = window.setTimeout(() => {
				translateFinalScheduleTimerByItemIdRef.current.delete(itemId)
				const latestSourceText = normalizeWhitespace(
					subtitleSourceTextByItemIdRef.current.get(itemId) ?? ''
				)
				if (!latestSourceText) return
				enqueueTranslateInput({
					inputOrigin,
					itemId,
					requestKind: 'final',
					text: latestSourceText
				})
			}, delayMilliseconds)
			translateFinalScheduleTimerByItemIdRef.current.set(itemId, timerId)
		},
		[clearTranslateFinalTimerByItemId, enqueueTranslateInput]
	)

	const handleTranslateSubtitleFinalPatch = useCallback(
		(patch: SubtitleFinalPatch) => {
			const normalizedText = normalizeWhitespace(patch.text)
			if (!normalizedText) return
			if (shouldDropSubtitleText(normalizedText)) return

			const now = Date.now()
			const roundedTimestamp =
				Math.round(now / subtitleDedupRoundedTimeWindowMilliseconds) *
				subtitleDedupRoundedTimeWindowMilliseconds
			const dedupeKey = `${normalizedText.toLowerCase()}::${roundedTimestamp}::${translateSettingsRef.current.myLanguageCode}`
			const previousTimestamp = subtitleDedupKeyTimestampByKeyRef.current.get(dedupeKey)
			if (typeof previousTimestamp === 'number' && now - previousTimestamp < 2500) {
				return
			}
			subtitleDedupKeyTimestampByKeyRef.current.set(dedupeKey, now)
			subtitleDedupKeyTimestampByKeyRef.current.forEach((value, key) => {
				if (now - value > 10_000) subtitleDedupKeyTimestampByKeyRef.current.delete(key)
			})

			const resolvedUtterance = resolveAudioUtterance(patch.itemId, patch.previousItemId)
			const mergedSourceText = mergeUtteranceText(
				subtitleSourceTextByItemIdRef.current.get(resolvedUtterance.id) ?? '',
				normalizedText
			)
			subtitleSegmentTextByItemIdRef.current.delete(patch.itemId)
			subtitleSourceTextByItemIdRef.current.set(resolvedUtterance.id, mergedSourceText)
			subtitlePreviousItemIdByItemIdRef.current.set(resolvedUtterance.id, resolvedUtterance.previousId)
			subtitleCommittedAtByItemIdRef.current.set(resolvedUtterance.id, patch.committedAt)
			if (typeof patch.confidence === 'number') {
				subtitleLatestConfidenceByItemIdRef.current.set(resolvedUtterance.id, patch.confidence)
			}
			activeAudioUtteranceRef.current = {
				id: resolvedUtterance.id,
				updatedAt: now
			}

			clearTranslateDraftTimerByItemId(resolvedUtterance.id)
			upsertSubtitleCard(resolvedUtterance.id, resolvedUtterance.previousId, mergedSourceText)
			setLiveSubtitleState(previousState => ({
				...previousState,
				activeSegmentId: resolvedUtterance.id,
				text: '',
				updatedAt: Date.now()
			}))
			scheduleDraftTranslateForItem(resolvedUtterance.id, 'audio')
			scheduleFinalTranslateForItem(resolvedUtterance.id, 'audio')
		},
		[
			clearTranslateDraftTimerByItemId,
			resolveAudioUtterance,
			scheduleDraftTranslateForItem,
			scheduleFinalTranslateForItem,
			upsertSubtitleCard
		]
	)

	const startChatClient = useCallback(() => {
		stopChatClient()
		clearReconnectTimer('chat')
		const chatClient = new ChatRealtimeClient({
			onConnectionStateChange: state => {
				setChatChannelState(state)
				switch (state) {
					case 'connected':
						setErrorMessage(null)
						hasSeenConnectedStateByModeRef.current.chat = true
						reconnectAttemptByChannelRef.current.chat = 0
						return
					case 'disconnected':
					case 'error':
						if (intentionalStopByChannelRef.current.chat) return
						scheduleReconnectRef.current('chat')
						return
					default:
						return
				}
			},
			onError: message => {
				setErrorMessage(message)
				setConnectionHealth(previousState => ({
					...previousState,
					lastErrorAt: Date.now()
				}))
			},
			onRemoteStream: stream => {
				setRemoteAudioStream(stream)
			},
			onTranscriptPatch: patch => {
				setChatTranscripts(previousMessages => {
					const result = upsertChatTranscript(previousMessages, patch, chatTranscriptSequenceRef.current)
					chatTranscriptSequenceRef.current = result.nextSequenceNumber
					return result.list
				})
			}
		})
		chatClientRef.current = chatClient
		void chatClient.start({
			instructions: chatInstructionsRef.current,
			model: defaultChatRealtimeModel,
			speechOutputEnabled: chatSpeechOutputEnabledRef.current,
			turnDelaySeconds: chatTurnDelaySecondsRef.current,
			voice: 'verse',
			voiceInputEnabled: voiceInputEnabledRef.current
		})
	}, [clearReconnectTimer, stopChatClient])

	const startTranslateClient = useCallback(() => {
		stopTranslateClient()
		clearReconnectTimer('translate')
		const translateClient = new LiveTranslateRealtimeClient({
			onConnectionStateChange: state => {
				setTranslateChannelState(state)
				switch (state) {
					case 'connected':
						setErrorMessage(null)
						reconnectAttemptByChannelRef.current.translate = 0
						flushPendingTranslateInputs()
						return
					case 'disconnected':
					case 'error':
						if (intentionalStopByChannelRef.current.translate) return
						scheduleReconnectRef.current('translate')
						return
					default:
						return
				}
			},
			onDraftDeltaPatch: patch => {
				setTranslateCards(previousCards => {
					const hasExistingCard = previousCards.some(card => card.id === patch.itemId)
					const nextCards = applyTranslateDraftPatch(
						previousCards,
						patch,
						translateSettingsRef.current,
						translateUtteranceSequenceRef.current
					)
					if (!hasExistingCard && nextCards.some(card => card.id === patch.itemId)) {
						translateUtteranceSequenceRef.current += 1
					}
					return nextCards
				})
			},
			onDraftDonePatch: patch => {
				setTranslateCards(previousCards => {
					const hasExistingCard = previousCards.some(card => card.id === patch.itemId)
					const nextCards = applyTranslateDraftPatch(
						previousCards,
						patch,
						translateSettingsRef.current,
						translateUtteranceSequenceRef.current
					)
					if (!hasExistingCard && nextCards.some(card => card.id === patch.itemId)) {
						translateUtteranceSequenceRef.current += 1
					}
					return nextCards
				})
			},
			onError: message => {
				setErrorMessage(message)
				setConnectionHealth(previousState => ({
					...previousState,
					lastErrorAt: Date.now()
				}))
			},
			onResultPatch: patch => {
				clearTranslateDraftTimerByItemId(patch.itemId)
				clearTranslateFinalTimerByItemId(patch.itemId)
				subtitleSourceTextByItemIdRef.current.delete(patch.itemId)
				subtitlePreviousItemIdByItemIdRef.current.delete(patch.itemId)
				subtitlePreviousUtteranceIdByUtteranceIdRef.current.delete(patch.itemId)
				subtitleLatestConfidenceByItemIdRef.current.delete(patch.itemId)
				subtitleCommittedAtByItemIdRef.current.delete(patch.itemId)
				translateDraftSequenceByItemIdRef.current.delete(patch.itemId)
				translateLastDraftSourceTextByItemIdRef.current.delete(patch.itemId)
				if (activeAudioUtteranceRef.current?.id === patch.itemId) {
					activeAudioUtteranceRef.current = null
				}
				setTranslateCards(previousCards => {
					const hasExistingCard = previousCards.some(card => card.id === patch.itemId)
					const nextCards = applyTranslateResultPatch(
						previousCards,
						patch,
						translateSettingsRef.current,
						translateUtteranceSequenceRef.current
					)
					if (!hasExistingCard && nextCards.some(card => card.id === patch.itemId)) {
						translateUtteranceSequenceRef.current += 1
					}
					return nextCards
				})
			}
		})
		liveTranslateClientRef.current = translateClient
		void translateClient.start({
			model: defaultChatRealtimeModel,
			myLanguageCode: translateSettingsRef.current.myLanguageCode,
			translateToLanguageCode: translateSettingsRef.current.translateToLanguageCode
		})
	}, [
		clearReconnectTimer,
		clearTranslateDraftTimerByItemId,
		clearTranslateFinalTimerByItemId,
		flushPendingTranslateInputs,
		stopTranslateClient
	])

	const startSubtitleClient = useCallback(() => {
		stopSubtitleClient()
		clearReconnectTimer('subtitle')
		const subtitleClient = new SubtitleTranscriptionClient({
			onConnectionStateChange: state => {
				setSubtitleChannelState(state)
				switch (state) {
					case 'connected':
						setErrorMessage(null)
						reconnectAttemptByChannelRef.current.subtitle = 0
						return
					case 'disconnected':
					case 'error':
						if (intentionalStopByChannelRef.current.subtitle) return
						scheduleReconnectRef.current('subtitle')
						return
					default:
						return
				}
			},
			onError: message => {
				setErrorMessage(message)
				setConnectionHealth(previousState => ({
					...previousState,
					lastErrorAt: Date.now()
				}))
			},
			onListeningStateChange: isListening => {
				setLiveSubtitleState(previousState => ({
					...previousState,
					isListening,
					updatedAt: Date.now()
				}))
			},
			onSubtitleDelta: patch => {
				const nextSegmentText = `${subtitleSegmentTextByItemIdRef.current.get(patch.itemId) ?? ''}${patch.textDelta}`
				const normalizedSegmentText = normalizeWhitespace(nextSegmentText)
				subtitleSegmentTextByItemIdRef.current.set(patch.itemId, nextSegmentText)
				if (shouldDropSubtitleText(normalizedSegmentText)) {
					setLiveSubtitleState(previousState => ({
						...previousState,
						activeSegmentId: patch.itemId,
						isListening: true,
						text: '',
						updatedAt: Date.now()
					}))
					return
				}
				const resolvedUtterance = resolveAudioUtterance(patch.itemId, patch.previousItemId)
				const mergedSourceText = mergeUtteranceText(
					subtitleSourceTextByItemIdRef.current.get(resolvedUtterance.id) ?? '',
					patch.textDelta
				)
				subtitleSourceTextByItemIdRef.current.set(resolvedUtterance.id, mergedSourceText)
				subtitlePreviousItemIdByItemIdRef.current.set(
					resolvedUtterance.id,
					resolvedUtterance.previousId
				)
				activeAudioUtteranceRef.current = {
					id: resolvedUtterance.id,
					updatedAt: Date.now()
				}
				upsertSubtitleCard(resolvedUtterance.id, resolvedUtterance.previousId, mergedSourceText)
				setLiveSubtitleState({
					activeSegmentId: resolvedUtterance.id,
					isListening: true,
					text: '',
					updatedAt: Date.now()
				})
				scheduleDraftTranslateForItem(resolvedUtterance.id, 'audio')
				scheduleFinalTranslateForItem(resolvedUtterance.id, 'audio')
			},
			onSubtitleFinal: handleTranslateSubtitleFinalPatch
		})
		subtitleClientRef.current = subtitleClient
		void subtitleClient.start({
			myLanguageCode: translateSettingsRef.current.myLanguageCode,
			translateToLanguageCode: translateSettingsRef.current.translateToLanguageCode,
			voiceInputEnabled: voiceInputEnabledRef.current
		})
	}, [
		clearReconnectTimer,
		handleTranslateSubtitleFinalPatch,
		resolveAudioUtterance,
		scheduleDraftTranslateForItem,
		scheduleFinalTranslateForItem,
		stopSubtitleClient,
		upsertSubtitleCard
	])

	const startModeRuntime = useCallback(
		(nextMode: LilacMode) => {
			setErrorMessage(null)
			switch (nextMode) {
				case 'chat':
					startChatClient()
					return
				case 'translate':
					startTranslateClient()
					startSubtitleClient()
					return
				default:
					return
			}
		},
		[startChatClient, startSubtitleClient, startTranslateClient]
	)

	const startChannel = useCallback(
		(channel: RuntimeChannel) => {
			switch (channel) {
				case 'chat':
					startChatClient()
					return
				case 'translate':
					startTranslateClient()
					return
				case 'subtitle':
					startSubtitleClient()
					return
				default:
					return
			}
		},
		[startChatClient, startSubtitleClient, startTranslateClient]
	)

	const scheduleReconnect = useCallback(
		(channel: RuntimeChannel) => {
			if (!isHydratedRef.current) return
			if (!shouldRunChannelForMode(channel, modeRef.current)) return
			clearReconnectTimer(channel)

			if (!isOnlineRef.current) {
				setStatusMessage('Offline. Waiting for network…')
				return
			}

			const nextAttempt = reconnectAttemptByChannelRef.current[channel] + 1
			reconnectAttemptByChannelRef.current[channel] = nextAttempt
			const reconnectDelayMilliseconds = calculateReconnectDelay(nextAttempt)

			reconnectTimerByChannelRef.current[channel] = window.setTimeout(() => {
				delete reconnectTimerByChannelRef.current[channel]
				if (!isHydratedRef.current) return
				if (!shouldRunChannelForMode(channel, modeRef.current)) return
				startChannel(channel)
			}, reconnectDelayMilliseconds)
		},
		[clearReconnectTimer, shouldRunChannelForMode, startChannel]
	)

	useEffect(() => {
		scheduleReconnectRef.current = scheduleReconnect
	}, [scheduleReconnect])

	useEffect(() => {
		chatInstructionsRef.current = chatInstructions
	}, [chatInstructions])

	useEffect(() => {
		chatTurnDelaySecondsRef.current = chatTurnDelaySeconds
	}, [chatTurnDelaySeconds])

	useEffect(() => {
		translateSettingsRef.current = translateSettings
	}, [translateSettings])

	useEffect(() => {
		voiceInputEnabledRef.current = globalAudioInputSettings.voiceInputEnabled
	}, [globalAudioInputSettings.voiceInputEnabled])

	useEffect(() => {
		chatSpeechOutputEnabledRef.current = chatOutputSettings.speechOutputEnabled
	}, [chatOutputSettings.speechOutputEnabled])

	useEffect(() => {
		modeRef.current = mode
	}, [mode])

	const setMode = useCallback(
		(nextMode: LilacMode) => {
			if (nextMode === modeRef.current) return
			stopAllClients()
			clearAllInMemoryState()
			setModeState(nextMode)
		},
		[clearAllInMemoryState, stopAllClients]
	)

	const setChatInstructions = useCallback((instructions: string) => {
		setChatInstructionsState(instructions)
	}, [])

	const setChatTurnDelaySeconds = useCallback((seconds: number) => {
		setChatTurnDelaySecondsState(normalizeTurnDelaySeconds(seconds))
	}, [])

	const setTranslateSettings = useCallback(
		(nextSettings: TranslateSettings) => {
			const sanitizedSettings = sanitizeTranslateSettings(nextSettings)
			clearAllTranslateStreamingTimers()
			subtitleSegmentTextByItemIdRef.current.clear()
			subtitleSourceTextByItemIdRef.current.clear()
			subtitlePreviousItemIdByItemIdRef.current.clear()
			subtitleUtteranceIdBySegmentItemIdRef.current.clear()
			subtitlePreviousUtteranceIdByUtteranceIdRef.current.clear()
			subtitleLatestConfidenceByItemIdRef.current.clear()
			subtitleCommittedAtByItemIdRef.current.clear()
			activeAudioUtteranceRef.current = null
			lastAudioUtteranceIdRef.current = null
			translateDraftSequenceByItemIdRef.current.clear()
			translateLastDraftSourceTextByItemIdRef.current.clear()
			pendingTranslateInputQueueRef.current = []
			setTranslateSettingsState(sanitizedSettings)
			if (modeRef.current === 'translate') {
				liveTranslateClientRef.current?.updateTranslateSettings(sanitizedSettings)
				subtitleClientRef.current?.updateSubtitleSettings(sanitizedSettings)
			}
		},
		[clearAllTranslateStreamingTimers]
	)

	const setVoiceInputEnabled = useCallback((voiceInputEnabled: boolean) => {
		setGlobalAudioInputSettings({ voiceInputEnabled })
		switch (modeRef.current) {
			case 'chat':
				void chatClientRef.current?.updateVoiceInputEnabled(voiceInputEnabled)
				return
			case 'translate':
				void subtitleClientRef.current?.updateVoiceInputEnabled(voiceInputEnabled)
				return
			default:
				return
		}
	}, [])

	const setChatSpeechOutputEnabled = useCallback((speechOutputEnabled: boolean) => {
		setChatOutputSettings({ speechOutputEnabled })
		if (modeRef.current === 'chat') {
			chatClientRef.current?.updateSpeechOutputEnabled(speechOutputEnabled)
		}
	}, [])

	const submitChatTextInput = useCallback((text: string) => {
		chatClientRef.current?.submitTextInput(text)
	}, [])

	const submitTranslateTextInput = useCallback(
		(text: string) => {
			const normalizedText = text.trim()
			if (!normalizedText) return
			const itemId = createClientItemId('typed')
			subtitleSourceTextByItemIdRef.current.set(itemId, normalizedText)
			setTranslateCards(previousCards => {
				const nextCard: UtteranceCard = {
					...createEmptyUtteranceCard(
						itemId,
						'text',
						translateSettingsRef.current,
						translateUtteranceSequenceRef.current
					),
					renderState: 'draft',
					sourceLanguageCode: translateSettingsRef.current.myLanguageCode,
					sourceText: normalizedText,
					status: 'translating'
				}
				translateUtteranceSequenceRef.current += 1
				const previousItemId =
					previousCards.length > 0 ? (previousCards[previousCards.length - 1]?.id ?? null) : null
				return insertCardByPreviousItemId(previousCards, nextCard, previousItemId)
			})
			if (isTranslateStreamingV2Enabled) {
				const nextDraftSequence = (translateDraftSequenceByItemIdRef.current.get(itemId) ?? 0) + 1
				translateDraftSequenceByItemIdRef.current.set(itemId, nextDraftSequence)
				translateLastDraftSourceTextByItemIdRef.current.set(itemId, normalizedText)
				enqueueTranslateInput({
					draftSequence: nextDraftSequence,
					inputOrigin: 'text',
					itemId,
					requestKind: 'draft',
					text: normalizedText
				})
				const timerId = window.setTimeout(() => {
					translateFinalScheduleTimerByItemIdRef.current.delete(itemId)
					enqueueTranslateInput({
						inputOrigin: 'text',
						itemId,
						requestKind: 'final',
						text: normalizedText
					})
				}, 450)
				translateFinalScheduleTimerByItemIdRef.current.set(itemId, timerId)
				return
			}
			enqueueTranslateInput({
				inputOrigin: 'text',
				itemId,
				requestKind: 'final',
				text: normalizedText
			})
		},
		[enqueueTranslateInput]
	)

	useEffect(() => {
		if (typeof window === 'undefined') return

		const storedMode = window.localStorage.getItem(storageKeys.mode)
		if (storedMode === 'chat' || storedMode === 'translate') {
			setModeState(storedMode)
		}

		const storedChatInstructions = window.localStorage.getItem(storageKeys.chatInstructions)
		if (storedChatInstructions) setChatInstructionsState(storedChatInstructions)

		const storedChatTurnDelaySeconds = window.localStorage.getItem(storageKeys.chatTurnDelaySeconds)
		if (storedChatTurnDelaySeconds) {
			setChatTurnDelaySecondsState(normalizeTurnDelaySeconds(storedChatTurnDelaySeconds))
		}

		const storedTranslateMyLanguageCode = window.localStorage.getItem(storageKeys.translateMyLanguage)
		const storedTranslateToLanguageCode = window.localStorage.getItem(storageKeys.translateToLanguage)
		const legacyPrimaryLanguageCode = window.localStorage.getItem(
			storageKeys.translatePrimaryLanguageLegacy
		)
		const legacySecondaryLanguageCode = window.localStorage.getItem(
			storageKeys.translateSecondaryLanguageLegacy
		)

		const hydratedTranslateSettings = sanitizeTranslateSettings(
			storedTranslateMyLanguageCode && storedTranslateToLanguageCode
				? {
						myLanguageCode: storedTranslateMyLanguageCode,
						translateToLanguageCode: storedTranslateToLanguageCode
					}
				: legacyPrimaryLanguageCode && legacySecondaryLanguageCode
					? {
							myLanguageCode: legacyPrimaryLanguageCode,
							translateToLanguageCode: legacySecondaryLanguageCode
						}
					: null
		)
		setTranslateSettingsState(hydratedTranslateSettings)
		window.localStorage.setItem(
			storageKeys.translateMyLanguage,
			hydratedTranslateSettings.myLanguageCode
		)
		window.localStorage.setItem(
			storageKeys.translateToLanguage,
			hydratedTranslateSettings.translateToLanguageCode
		)

		const storedVoiceInputEnabled = window.localStorage.getItem(storageKeys.voiceInputEnabled)
		setGlobalAudioInputSettings({
			voiceInputEnabled: parseStoredBoolean(
				storedVoiceInputEnabled,
				defaultGlobalAudioInputSettings.voiceInputEnabled
			)
		})

		const storedSpeechOutputEnabled = window.localStorage.getItem(storageKeys.chatSpeechOutputEnabled)
		setChatOutputSettings({
			speechOutputEnabled: parseStoredBoolean(
				storedSpeechOutputEnabled,
				defaultChatOutputSettings.speechOutputEnabled
			)
		})

		setIsHydrated(true)
		isHydratedRef.current = true
	}, [])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(storageKeys.mode, mode)
	}, [isHydrated, mode])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(storageKeys.chatInstructions, chatInstructions)
		if (modeRef.current === 'chat') chatClientRef.current?.updateInstructions(chatInstructions)
	}, [chatInstructions, isHydrated])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(storageKeys.chatTurnDelaySeconds, String(chatTurnDelaySeconds))
		if (modeRef.current !== 'chat') return
		chatClientRef.current?.updateTurnDelaySeconds(chatTurnDelaySeconds)
	}, [chatTurnDelaySeconds, isHydrated])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(storageKeys.translateMyLanguage, translateSettings.myLanguageCode)
		window.localStorage.setItem(
			storageKeys.translateToLanguage,
			translateSettings.translateToLanguageCode
		)
	}, [isHydrated, translateSettings.myLanguageCode, translateSettings.translateToLanguageCode])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(
			storageKeys.voiceInputEnabled,
			String(globalAudioInputSettings.voiceInputEnabled)
		)
		switch (modeRef.current) {
			case 'chat':
				void chatClientRef.current?.updateVoiceInputEnabled(globalAudioInputSettings.voiceInputEnabled)
				return
			case 'translate':
				void subtitleClientRef.current?.updateVoiceInputEnabled(
					globalAudioInputSettings.voiceInputEnabled
				)
				return
			default:
				return
		}
	}, [globalAudioInputSettings.voiceInputEnabled, isHydrated])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(
			storageKeys.chatSpeechOutputEnabled,
			String(chatOutputSettings.speechOutputEnabled)
		)
		if (modeRef.current === 'chat') {
			chatClientRef.current?.updateSpeechOutputEnabled(chatOutputSettings.speechOutputEnabled)
		}
	}, [chatOutputSettings.speechOutputEnabled, isHydrated])

	useEffect(() => {
		if (!isHydrated) return
		startModeRuntime(mode)
		return () => {
			stopAllClients()
		}
	}, [isHydrated, mode, startModeRuntime, stopAllClients])

	useEffect(() => {
		if (typeof window === 'undefined') return

		function handleOnline(): void {
			isOnlineRef.current = true
			setIsOnline(true)
			setStatusMessage(null)
			if (modeRef.current === 'chat' && chatChannelState !== 'connected') {
				scheduleReconnect('chat')
			}
			if (modeRef.current === 'translate') {
				if (translateChannelState !== 'connected') scheduleReconnect('translate')
				if (subtitleChannelState !== 'connected') scheduleReconnect('subtitle')
			}
		}

		function handleOffline(): void {
			isOnlineRef.current = false
			setIsOnline(false)
			if (typeof reconnectStatusTimerRef.current === 'number') {
				window.clearTimeout(reconnectStatusTimerRef.current)
				reconnectStatusTimerRef.current = null
			}
			setStatusMessage('Offline. Waiting for network…')
		}

		isOnlineRef.current = navigator.onLine
		setIsOnline(navigator.onLine)
		window.addEventListener('online', handleOnline)
		window.addEventListener('offline', handleOffline)
		return () => {
			window.removeEventListener('online', handleOnline)
			window.removeEventListener('offline', handleOffline)
		}
	}, [chatChannelState, scheduleReconnect, subtitleChannelState, translateChannelState])

	useEffect(() => {
		if (translateChannelState === 'connected' && subtitleChannelState === 'connected') {
			hasSeenConnectedStateByModeRef.current.translate = true
		}
	}, [subtitleChannelState, translateChannelState])

	useEffect(() => {
		const nextConnectionHealthState: ConnectionHealthState = {
			isReconnecting: false,
			lastErrorAt: connectionHealth.lastErrorAt,
			subtitleConnected: subtitleChannelState === 'connected',
			translateConnected: translateChannelState === 'connected'
		}

		switch (mode) {
			case 'chat': {
				nextConnectionHealthState.isReconnecting =
					chatChannelState !== 'connected' &&
					(chatChannelState === 'connecting' ||
						typeof reconnectTimerByChannelRef.current.chat === 'number')
				break
			}
			case 'translate': {
				nextConnectionHealthState.isReconnecting =
					(translateChannelState !== 'connected' || subtitleChannelState !== 'connected') &&
					(translateChannelState === 'connecting' ||
						subtitleChannelState === 'connecting' ||
						typeof reconnectTimerByChannelRef.current.translate === 'number' ||
						typeof reconnectTimerByChannelRef.current.subtitle === 'number')
				break
			}
			default:
				nextConnectionHealthState.isReconnecting = false
		}

		setConnectionHealth(nextConnectionHealthState)
	}, [
		chatChannelState,
		connectionHealth.lastErrorAt,
		mode,
		subtitleChannelState,
		translateChannelState
	])

	useEffect(() => {
		if (!isHydrated) return
		const isOffline = !isOnline
		if (isOffline) {
			setStatusMessage('Offline. Waiting for network…')
			return
		}

		const shouldShowReconnectForMode =
			mode === 'chat'
				? chatChannelState !== 'connected'
				: translateChannelState !== 'connected' && subtitleChannelState !== 'connected'
		const hasSeenConnectedStateForMode = hasSeenConnectedStateByModeRef.current[mode]

		if (!shouldShowReconnectForMode || !hasSeenConnectedStateForMode) {
			if (typeof reconnectStatusTimerRef.current === 'number') {
				window.clearTimeout(reconnectStatusTimerRef.current)
				reconnectStatusTimerRef.current = null
			}
			setStatusMessage(null)
			return
		}

		if (typeof reconnectStatusTimerRef.current === 'number') return
		reconnectStatusTimerRef.current = window.setTimeout(() => {
			reconnectStatusTimerRef.current = null
			const stillNeedsReconnect =
				modeRef.current === 'chat'
					? chatChannelState !== 'connected'
					: translateChannelState !== 'connected' && subtitleChannelState !== 'connected'
			if (!stillNeedsReconnect) return
			setStatusMessage('Reconnecting…')
		}, reconnectStatusGraceMilliseconds)

		return () => {
			if (typeof reconnectStatusTimerRef.current !== 'number') return
			window.clearTimeout(reconnectStatusTimerRef.current)
			reconnectStatusTimerRef.current = null
		}
	}, [chatChannelState, isHydrated, isOnline, mode, subtitleChannelState, translateChannelState])

	useEffect(() => {
		if (!isHydrated) return
		switch (mode) {
			case 'chat':
				setConnectionState(mapChatConnectionState(chatChannelState))
				return
			case 'translate':
				setConnectionState(mapTranslateConnectionState(translateChannelState, subtitleChannelState))
				return
			default:
				setConnectionState('idle')
				return
		}
	}, [chatChannelState, isHydrated, mode, subtitleChannelState, translateChannelState])

	useEffect(() => {
		return () => {
			for (const timerId of Object.values(reconnectTimerByChannelRef.current)) {
				if (typeof timerId === 'number') window.clearTimeout(timerId)
			}
			if (typeof reconnectStatusTimerRef.current === 'number') {
				window.clearTimeout(reconnectStatusTimerRef.current)
				reconnectStatusTimerRef.current = null
			}
			clearAllTranslateStreamingTimers()
		}
	}, [clearAllTranslateStreamingTimers])

	const contextValue = useMemo<LilacModeRuntimeContextValue>(
		() => ({
			chatInstructions,
			chatSpeechOutputEnabled: chatOutputSettings.speechOutputEnabled,
			chatTranscripts,
			chatTurnDelaySeconds,
			connectionState,
			errorMessage,
			getDirectionColor: getDirectionColorClass,
			liveSubtitleState,
			mode,
			remoteAudioStream,
			setChatInstructions,
			setChatSpeechOutputEnabled,
			setChatTurnDelaySeconds,
			setMode,
			setTranslateSettings,
			setVoiceInputEnabled,
			statusMessage,
			submitChatTextInput,
			submitTranslateTextInput,
			translateCards,
			translateSettings,
			voiceInputEnabled: globalAudioInputSettings.voiceInputEnabled
		}),
		[
			chatInstructions,
			chatOutputSettings.speechOutputEnabled,
			chatTranscripts,
			chatTurnDelaySeconds,
			connectionState,
			errorMessage,
			liveSubtitleState,
			mode,
			remoteAudioStream,
			setChatInstructions,
			setChatSpeechOutputEnabled,
			setChatTurnDelaySeconds,
			setMode,
			setTranslateSettings,
			setVoiceInputEnabled,
			statusMessage,
			submitChatTextInput,
			submitTranslateTextInput,
			translateCards,
			translateSettings,
			globalAudioInputSettings.voiceInputEnabled
		]
	)

	return (
		<LilacModeRuntimeContext.Provider value={contextValue}>
			{children}
		</LilacModeRuntimeContext.Provider>
	)
}

export function useLilacModeRuntime(): LilacModeRuntimeContextValue {
	const contextValue = useContext(LilacModeRuntimeContext)
	if (!contextValue) {
		throw new Error('useLilacModeRuntime must be used within a LilacModeRuntimeProvider')
	}
	return contextValue
}
