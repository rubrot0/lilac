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

import { emitLilacTestBusEvent } from '@/evals/testBus'
import { ChatRealtimeClient, type ChatTranscriptPatch } from '@/realtime/chatRealtimeClient'
import { resolveLanguageCode } from '@/realtime/languageCatalog'
import {
	LiveTranslateRealtimeClient,
	type TranslateDraftInputPayload,
	type TranslateInputPayload
} from '@/realtime/liveTranslateRealtimeClient'
import { resolveChatRealtimeModelFromEnvironment } from '@/realtime/modelConfig'
import { SystemLeakTextSchema } from '@/realtime/schemas'
import type {
	ChatOutputSettings,
	ChatTranscriptMessage,
	ConnectionHealthState,
	ConnectionUiState,
	GlobalAudioInputSettings,
	LilacMode,
	LiveSubtitleState,
	ModeConnectionState,
	TranslateRuntimeState,
	TranslateSettings,
	UtteranceCard,
	UtteranceDirection
} from '@/realtime/sessionTypes'
import {
	type SubtitleFinalPatch,
	SubtitleTranscriptionClient
} from '@/realtime/subtitleTranscriptionClient'
import {
	applySubtitleSegmentDelta,
	applySubtitleSegmentFinal,
	applyTranslateDraftPatch as applyTranslateRuntimeDraftPatch,
	applyTranslateResultPatch as applyTranslateRuntimeResultPatch,
	createTranslateRuntimeState,
	getTranslateCommittedSourceText,
	getTranslateLatestConfidence,
	selectLiveSubtitleState,
	selectTranslateCards,
	upsertTypedTranslateUtterance
} from '@/realtime/translateRuntimeState'

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
const finalTranslateLowConfidenceThreshold = 0.6
const finalTranslateLowConfidenceDelayMilliseconds = 280
const finalTranslateSilenceDelayMilliseconds = 1200
const minimumDraftTextLength = 2
const minimumDraftTextDeltaLength = 4
const isTranslateStreamingV2Enabled =
	process.env.NEXT_PUBLIC_LILAC_TRANSLATE_STREAMING_V2 !== 'false'

function parsePositiveIntegerEnvironmentValue(
	name: string,
	fallbackValue: number,
	bounds: { maximum: number; minimum: number }
): number {
	const rawValue = process.env[name]
	if (!rawValue) return fallbackValue
	const parsedValue = Number.parseInt(rawValue, 10)
	if (!Number.isFinite(parsedValue)) return fallbackValue
	return Math.max(bounds.minimum, Math.min(bounds.maximum, parsedValue))
}

const draftTranslateDebounceMilliseconds = parsePositiveIntegerEnvironmentValue(
	'NEXT_PUBLIC_LILAC_TRANSLATE_DRAFT_DEBOUNCE_MS',
	300,
	{ maximum: 2_000, minimum: 100 }
)
const systemLeakMatcherList = SystemLeakTextSchema.parse(undefined).map(matcher =>
	matcher.toLowerCase()
)
const systemLeakPatternList = [
	/\btrans\s*cribe\s+spoken\s+words\s+only\b/i,
	/\bdo\s+not\s+add\s+labels\b/i,
	/\bmetadata\s*,?\s*or\s+context\s+notes\b/i,
	/\bpreserve\s+punctuation\s+and\s+proper\s+nouns\b/i,
	/\blike?ly\s+conversation\s+languages\b/i
]

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

function isAsciiDigitCharacter(value: string): boolean {
	return value >= '0' && value <= '9'
}

function isUnicodeLetterCharacter(value: string): boolean {
	return value.toLowerCase() !== value.toUpperCase()
}

function canonicalizeTranscriptionText(value: string): string {
	const punctuationNormalizedValue = normalizeWhitespace(value)
		.toLowerCase()
		.replace(/\s+([,.;!?])/g, '$1')
	let canonicalValue = ''
	for (const character of punctuationNormalizedValue) {
		if (isAsciiDigitCharacter(character) || isUnicodeLetterCharacter(character)) {
			canonicalValue += character
		}
	}
	return canonicalValue
}

function splitSentenceList(value: string): string[] {
	return value
		.split(/(?<=[.!?])\s+/)
		.map(sentence => normalizeWhitespace(sentence))
		.filter(Boolean)
}

function isEquivalentTranscriptionChunk(leftValue: string, rightValue: string): boolean {
	const normalizedLeftValue = canonicalizeTranscriptionText(leftValue)
	const normalizedRightValue = canonicalizeTranscriptionText(rightValue)
	if (!normalizedLeftValue || !normalizedRightValue) return false
	if (normalizedLeftValue === normalizedRightValue) return true
	if (
		normalizedLeftValue.includes(normalizedRightValue) &&
		normalizedRightValue.length >= Math.floor(normalizedLeftValue.length * 0.7)
	) {
		return true
	}
	if (
		normalizedRightValue.includes(normalizedLeftValue) &&
		normalizedLeftValue.length >= Math.floor(normalizedRightValue.length * 0.7)
	) {
		return true
	}
	return false
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
	for (const pattern of systemLeakPatternList) {
		if (pattern.test(normalizedValue)) return true
	}
	const collapsedValue = canonicalizeTranscriptionText(normalizedValue)
	if (collapsedValue.includes('transcribespokenwordsonly')) return true
	if (collapsedValue.includes('donotaddlabels')) return true
	if (collapsedValue.includes('metadataorcontextnotes')) return true
	if (normalizedValue === 'context') return true
	if (normalizedValue === 'context:') return true
	return false
}

function sanitizeSubtitleText(value: string): string {
	const normalizedValue = normalizeWhitespace(value)
	if (!normalizedValue) return ''
	const sentenceList = splitSentenceList(normalizedValue)
	if (sentenceList.length === 0) {
		return shouldDropSubtitleText(normalizedValue) ? '' : normalizedValue
	}
	const filteredSentenceList: string[] = []
	for (const sentence of sentenceList) {
		if (shouldDropSubtitleText(sentence)) continue
		const previousSentence = filteredSentenceList[filteredSentenceList.length - 1]
		if (previousSentence && isEquivalentTranscriptionChunk(previousSentence, sentence)) continue
		filteredSentenceList.push(sentence)
	}
	if (filteredSentenceList.length === 0) return ''
	return normalizeWhitespace(filteredSentenceList.join(' '))
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
	connectionUiState: ConnectionUiState
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
	const [connectionUiState, setConnectionUiState] = useState<ConnectionUiState>({
		isLive: false,
		isOffline: false,
		isReconnecting: false,
		lastHealthyAt: null,
		statusMessage: null
	})
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
	const liveSubtitleStateRef = useRef(defaultLiveSubtitleState)

	const pendingTranslateInputQueueRef = useRef<PendingTranslateInput[]>([])
	const chatTranscriptSequenceRef = useRef(1)
	const translateRuntimeStateRef = useRef<TranslateRuntimeState>(createTranslateRuntimeState())
	const subtitleDedupKeyTimestampByKeyRef = useRef<Map<string, number>>(new Map())
	const subtitleRawSegmentTextByItemIdRef = useRef<Map<string, string>>(new Map())
	const translateDraftSequenceByItemIdRef = useRef<Map<string, number>>(new Map())
	const translateLastDraftSourceTextByItemIdRef = useRef<Map<string, string>>(new Map())
	const translateDraftScheduleTimerByItemIdRef = useRef<Map<string, number>>(new Map())
	const translateFinalScheduleTimerByItemIdRef = useRef<Map<string, number>>(new Map())
	const reconnectTimerByChannelRef = useRef<Partial<Record<RuntimeChannel, number>>>({})
	const reconnectStatusTimerRef = useRef<null | number>(null)
	const scheduleReconnectRef = useRef<(channel: RuntimeChannel) => void>(() => {})
	const reconnectAttemptByChannelRef = useRef<Record<RuntimeChannel, number>>({
		chat: 0,
		subtitle: 0,
		translate: 0
	})
	const previousChatEventFingerprintByIdRef = useRef<Map<string, string>>(new Map())
	const previousSubtitleFingerprintRef = useRef('')
	const previousTranslateCardFingerprintByIdRef = useRef<Map<string, string>>(new Map())
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

	const syncTranslateRuntimeState = useCallback((nextState: TranslateRuntimeState): void => {
		translateRuntimeStateRef.current = nextState
		setTranslateCards(selectTranslateCards(nextState))
		const nextLiveSubtitleState = selectLiveSubtitleState(
			nextState,
			liveSubtitleStateRef.current.isListening,
			Date.now()
		)
		liveSubtitleStateRef.current = nextLiveSubtitleState
		setLiveSubtitleState(nextLiveSubtitleState)
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
		subtitleRawSegmentTextByItemIdRef.current.clear()
		translateRuntimeStateRef.current = createTranslateRuntimeState()
		translateDraftSequenceByItemIdRef.current.clear()
		translateLastDraftSourceTextByItemIdRef.current.clear()
		setSubtitleChannelState('disconnected')
		liveSubtitleStateRef.current = defaultLiveSubtitleState
		setLiveSubtitleState(defaultLiveSubtitleState)
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
		liveSubtitleStateRef.current = defaultLiveSubtitleState
		setLiveSubtitleState(defaultLiveSubtitleState)
		translateRuntimeStateRef.current = createTranslateRuntimeState()
		subtitleDedupKeyTimestampByKeyRef.current.clear()
		subtitleRawSegmentTextByItemIdRef.current.clear()
		translateDraftSequenceByItemIdRef.current.clear()
		translateLastDraftSourceTextByItemIdRef.current.clear()
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

	const scheduleDraftTranslateForItem = useCallback(
		(itemId: string, inputOrigin: 'audio' | 'text') => {
			if (!isTranslateStreamingV2Enabled) return
			clearTranslateDraftTimerByItemId(itemId)
			const timerId = window.setTimeout(() => {
				translateDraftScheduleTimerByItemIdRef.current.delete(itemId)
				const latestSourceText = normalizeWhitespace(
					getTranslateCommittedSourceText(translateRuntimeStateRef.current, itemId)
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
			const confidence = getTranslateLatestConfidence(translateRuntimeStateRef.current, itemId)
			const lowConfidenceDelayMilliseconds =
				typeof confidence === 'number' && confidence < finalTranslateLowConfidenceThreshold
					? finalTranslateLowConfidenceDelayMilliseconds
					: 0
			const delayMilliseconds = finalTranslateSilenceDelayMilliseconds + lowConfidenceDelayMilliseconds
			const timerId = window.setTimeout(() => {
				translateFinalScheduleTimerByItemIdRef.current.delete(itemId)
				const latestSourceText = normalizeWhitespace(
					getTranslateCommittedSourceText(translateRuntimeStateRef.current, itemId)
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
			const normalizedText = sanitizeSubtitleText(patch.text)
			subtitleRawSegmentTextByItemIdRef.current.delete(patch.itemId)
			if (!normalizedText) return

			const now = Date.now()
			const roundedTimestamp =
				Math.round(now / subtitleDedupRoundedTimeWindowMilliseconds) *
				subtitleDedupRoundedTimeWindowMilliseconds
			const canonicalText = canonicalizeTranscriptionText(normalizedText)
			const dedupeKey = `${canonicalText}::${roundedTimestamp}::${translateSettingsRef.current.myLanguageCode}`
			const previousTimestamp = subtitleDedupKeyTimestampByKeyRef.current.get(dedupeKey)
			if (typeof previousTimestamp === 'number' && now - previousTimestamp < 2500) {
				return
			}
			subtitleDedupKeyTimestampByKeyRef.current.set(dedupeKey, now)
			subtitleDedupKeyTimestampByKeyRef.current.forEach((value, key) => {
				if (now - value > 10_000) subtitleDedupKeyTimestampByKeyRef.current.delete(key)
			})

			const nextState = applySubtitleSegmentFinal(translateRuntimeStateRef.current, {
				...patch,
				settings: translateSettingsRef.current,
				text: normalizedText
			})
			syncTranslateRuntimeState(nextState)
			const utteranceId = nextState.segmentById[patch.itemId]?.utteranceId
			if (!utteranceId) return
			clearTranslateDraftTimerByItemId(utteranceId)
			scheduleDraftTranslateForItem(utteranceId, 'audio')
			scheduleFinalTranslateForItem(utteranceId, 'audio')
		},
		[
			clearTranslateDraftTimerByItemId,
			scheduleDraftTranslateForItem,
			scheduleFinalTranslateForItem,
			syncTranslateRuntimeState
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
			model: resolveChatRealtimeModelFromEnvironment(),
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
				const nextState = applyTranslateRuntimeDraftPatch(
					translateRuntimeStateRef.current,
					patch,
					translateSettingsRef.current,
					Date.now()
				)
				syncTranslateRuntimeState(nextState)
			},
			onDraftDonePatch: patch => {
				const nextState = applyTranslateRuntimeDraftPatch(
					translateRuntimeStateRef.current,
					patch,
					translateSettingsRef.current,
					Date.now()
				)
				syncTranslateRuntimeState(nextState)
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
				translateDraftSequenceByItemIdRef.current.delete(patch.itemId)
				translateLastDraftSourceTextByItemIdRef.current.delete(patch.itemId)
				const nextState = applyTranslateRuntimeResultPatch(
					translateRuntimeStateRef.current,
					patch,
					translateSettingsRef.current,
					Date.now()
				)
				syncTranslateRuntimeState(nextState)
			}
		})
		liveTranslateClientRef.current = translateClient
		void translateClient.start({
			model: resolveChatRealtimeModelFromEnvironment(),
			myLanguageCode: translateSettingsRef.current.myLanguageCode,
			translateToLanguageCode: translateSettingsRef.current.translateToLanguageCode
		})
	}, [
		clearReconnectTimer,
		clearTranslateDraftTimerByItemId,
		clearTranslateFinalTimerByItemId,
		flushPendingTranslateInputs,
		stopTranslateClient,
		syncTranslateRuntimeState
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
				const nextLiveSubtitleState = selectLiveSubtitleState(
					translateRuntimeStateRef.current,
					isListening,
					Date.now()
				)
				liveSubtitleStateRef.current = nextLiveSubtitleState
				setLiveSubtitleState(nextLiveSubtitleState)
			},
			onSubtitleDelta: patch => {
				const previousRawSegmentText = subtitleRawSegmentTextByItemIdRef.current.get(patch.itemId) ?? ''
				const nextRawSegmentText = `${previousRawSegmentText}${patch.textDelta}`
				subtitleRawSegmentTextByItemIdRef.current.set(patch.itemId, nextRawSegmentText)
				const sanitizedSegmentText = sanitizeSubtitleText(nextRawSegmentText)
				if (!sanitizedSegmentText) {
					return
				}
				const nextState = applySubtitleSegmentDelta(translateRuntimeStateRef.current, {
					itemId: patch.itemId,
					now: Date.now(),
					previousItemId: patch.previousItemId ?? null,
					settings: translateSettingsRef.current,
					text: sanitizedSegmentText
				})
				liveSubtitleStateRef.current = {
					...liveSubtitleStateRef.current,
					isListening: true
				}
				syncTranslateRuntimeState(nextState)
				const utteranceId = nextState.segmentById[patch.itemId]?.utteranceId
				if (!utteranceId) return
				scheduleDraftTranslateForItem(utteranceId, 'audio')
				scheduleFinalTranslateForItem(utteranceId, 'audio')
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
		scheduleDraftTranslateForItem,
		scheduleFinalTranslateForItem,
		stopSubtitleClient,
		syncTranslateRuntimeState
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
			subtitleRawSegmentTextByItemIdRef.current.clear()
			translateRuntimeStateRef.current = createTranslateRuntimeState()
			translateDraftSequenceByItemIdRef.current.clear()
			translateLastDraftSourceTextByItemIdRef.current.clear()
			pendingTranslateInputQueueRef.current = []
			setTranslateSettingsState(sanitizedSettings)
			setTranslateCards([])
			liveSubtitleStateRef.current = defaultLiveSubtitleState
			setLiveSubtitleState(defaultLiveSubtitleState)
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
			const nextState = upsertTypedTranslateUtterance(translateRuntimeStateRef.current, {
				itemId,
				now: Date.now(),
				settings: translateSettingsRef.current,
				text: normalizedText
			})
			syncTranslateRuntimeState(nextState)
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
		[enqueueTranslateInput, syncTranslateRuntimeState]
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
		if (!isHydrated) return
		const isLive =
			mode === 'chat'
				? chatChannelState === 'connected'
				: translateChannelState === 'connected' && subtitleChannelState === 'connected'
		const isReconnecting = statusMessage === 'Reconnecting…'
		const isOfflineState = !isOnline
		setConnectionUiState(previousState => ({
			isLive,
			isOffline: isOfflineState,
			isReconnecting,
			lastHealthyAt: isLive ? Date.now() : previousState.lastHealthyAt,
			statusMessage: isOfflineState
				? 'Offline. Waiting for network…'
				: isReconnecting
					? 'Reconnecting…'
					: isLive
						? 'Live'
						: connectionState === 'connecting'
							? 'Connecting…'
							: connectionState === 'error'
								? (errorMessage ?? 'Connection error.')
								: null
		}))
	}, [
		chatChannelState,
		connectionState,
		errorMessage,
		isHydrated,
		isOnline,
		mode,
		statusMessage,
		subtitleChannelState,
		translateChannelState
	])

	useEffect(() => {
		const nextFingerprintById = new Map<string, string>()
		for (const transcript of chatTranscripts) {
			const fingerprint = `${transcript.role}::${transcript.status}::${transcript.source}::${transcript.text}`
			nextFingerprintById.set(transcript.id, fingerprint)
			if (previousChatEventFingerprintByIdRef.current.get(transcript.id) === fingerprint) continue
			emitLilacTestBusEvent({
				eventType: 'chat_transcript_patch',
				messageId: transcript.id,
				role: transcript.role,
				source: transcript.source,
				status: transcript.status,
				text: transcript.text
			})
		}
		previousChatEventFingerprintByIdRef.current = nextFingerprintById
	}, [chatTranscripts])

	useEffect(() => {
		const fingerprint = `${liveSubtitleState.activeSegmentId ?? 'none'}::${liveSubtitleState.isListening}::${liveSubtitleState.text}`
		if (previousSubtitleFingerprintRef.current === fingerprint) return
		previousSubtitleFingerprintRef.current = fingerprint
		emitLilacTestBusEvent({
			activeSegmentId: liveSubtitleState.activeSegmentId,
			eventType: 'subtitle_state_changed',
			isListening: liveSubtitleState.isListening,
			text: liveSubtitleState.text
		})
	}, [liveSubtitleState.activeSegmentId, liveSubtitleState.isListening, liveSubtitleState.text])

	useEffect(() => {
		const nextFingerprintById = new Map<string, string>()
		for (const card of translateCards) {
			const targetText = card.translatedText || card.draftTranslatedText || ''
			const fingerprint = `${card.direction}::${card.renderState}::${card.sourceText}::${targetText}`
			nextFingerprintById.set(card.id, fingerprint)
			if (previousTranslateCardFingerprintByIdRef.current.get(card.id) === fingerprint) continue
			emitLilacTestBusEvent({
				cardId: card.id,
				direction: card.direction,
				eventType: 'translate_card_patch',
				renderState: card.renderState,
				sourceText: card.sourceText,
				targetText
			})
		}
		previousTranslateCardFingerprintByIdRef.current = nextFingerprintById
	}, [translateCards])

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
			connectionUiState,
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
			connectionUiState,
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
