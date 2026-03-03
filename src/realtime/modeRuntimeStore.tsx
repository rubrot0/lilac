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
	LiveTranslateRealtimeClient,
	type LiveTranslateResultPatch,
	type TranslateInputPayload
} from '@/realtime/liveTranslateRealtimeClient'
import { defaultChatRealtimeModel } from '@/realtime/modelConfig'
import type {
	ChatOutputSettings,
	ChatTranscriptMessage,
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

type PendingTranslateInput = TranslateInputPayload & {
	previousItemId?: null | string
}

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
	translateSettings: TranslateSettings
): UtteranceCard {
	return {
		createdAt: Date.now(),
		direction: 'my_to_target',
		id: itemId,
		inputOrigin,
		sourceItemId: itemId,
		sourceLanguageCode: translateSettings.myLanguageCode,
		sourceText: '',
		status: 'streaming',
		targetLanguageCode: translateSettings.translateToLanguageCode,
		translatedText: ''
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
	patch: ChatTranscriptPatch
): ChatTranscriptMessage[] {
	const existingIndex = existingList.findIndex(item => item.id === patch.id)
	const existingItem = existingIndex >= 0 ? existingList[existingIndex] : null

	if (
		existingItem?.role === 'assistant' &&
		existingItem.source === 'response_output_text' &&
		patch.source === 'response_output_audio_transcript'
	) {
		return existingList
	}

	const updatedText =
		typeof patch.replaceText === 'string'
			? patch.replaceText
			: `${existingItem?.text ?? ''}${patch.appendText ?? ''}`

	const nextItem: ChatTranscriptMessage = {
		createdAt: existingItem?.createdAt ?? Date.now(),
		id: patch.id,
		role: patch.role,
		source: patch.source,
		status: patch.status ?? existingItem?.status ?? 'streaming',
		text: updatedText
	}

	if (existingIndex === -1) {
		return [...existingList, nextItem]
	}

	const nextList = existingList.slice()
	nextList[existingIndex] = nextItem
	return nextList
}

function applyTranslateResultPatch(
	cardList: UtteranceCard[],
	patch: LiveTranslateResultPatch,
	translateSettings: TranslateSettings
): UtteranceCard[] {
	const existingCard = cardList.find(card => card.id === patch.itemId) ?? null
	const baseCard = existingCard
		? (() => {
				const { errorMessage: _errorMessage, responseId: _responseId, ...restCard } = existingCard
				return restCard
			})()
		: createEmptyUtteranceCard(patch.itemId, patch.inputOrigin, translateSettings)

	const nextCard: UtteranceCard = {
		...baseCard,
		direction: patch.direction,
		inputOrigin: patch.inputOrigin,
		sourceLanguageCode: normalizeLanguageCode(patch.sourceLanguageCode),
		sourceText: patch.sourceText.trim() ? patch.sourceText : (existingCard?.sourceText ?? ''),
		status: patch.status,
		targetLanguageCode: normalizeLanguageCode(patch.targetLanguageCode),
		translatedText: patch.translatedText,
		...(patch.status === 'error' ? { errorMessage: patch.translatedText } : {}),
		...(patch.responseId ? { responseId: patch.responseId } : {})
	}

	return insertCardByPreviousItemId(cardList, nextCard)
}

function createSourceCardFromFinalSubtitle(
	patch: SubtitleFinalPatch,
	translateSettings: TranslateSettings
): UtteranceCard {
	const normalizedSourceText = patch.text.trim()
	return {
		createdAt: Date.now(),
		direction: 'my_to_target',
		id: patch.itemId,
		inputOrigin: 'audio',
		sourceItemId: patch.itemId,
		sourceLanguageCode: translateSettings.myLanguageCode,
		sourceText: normalizedSourceText,
		status: 'translating',
		targetLanguageCode: translateSettings.translateToLanguageCode,
		translatedText: ''
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
	const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null)
	const [chatChannelState, setChatChannelState] = useState<ChannelConnectionState>('disconnected')
	const [translateChannelState, setTranslateChannelState] =
		useState<ChannelConnectionState>('disconnected')
	const [subtitleChannelState, setSubtitleChannelState] =
		useState<ChannelConnectionState>('disconnected')
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
	const reconnectTimerByChannelRef = useRef<Partial<Record<RuntimeChannel, number>>>({})
	const scheduleReconnectRef = useRef<(channel: RuntimeChannel) => void>(() => {})
	const reconnectAttemptByChannelRef = useRef<Record<RuntimeChannel, number>>({
		chat: 0,
		subtitle: 0,
		translate: 0
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
	}, [])

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
		pendingTranslateInputQueueRef.current = []
	}, [])

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
			translateClient.submitInput(nextInput)
		}
	}, [])

	const enqueueTranslateInput = useCallback(
		(input: PendingTranslateInput) => {
			const alreadyQueued = pendingTranslateInputQueueRef.current.some(
				queuedInput => queuedInput.itemId === input.itemId
			)
			if (alreadyQueued) return
			pendingTranslateInputQueueRef.current.push(input)
			flushPendingTranslateInputs()
		},
		[flushPendingTranslateInputs]
	)

	const handleTranslateSubtitleFinalPatch = useCallback(
		(patch: SubtitleFinalPatch) => {
			if (!patch.text.trim()) return
			setTranslateCards(previousCards => {
				const existingCard = previousCards.find(card => card.id === patch.itemId)
				if (existingCard) return previousCards
				const nextCard = createSourceCardFromFinalSubtitle(patch, translateSettingsRef.current)
				return insertCardByPreviousItemId(previousCards, nextCard, patch.previousItemId)
			})
			enqueueTranslateInput({
				inputOrigin: 'audio',
				itemId: patch.itemId,
				text: patch.text,
				...(patch.previousItemId === null || typeof patch.previousItemId === 'string'
					? { previousItemId: patch.previousItemId }
					: {})
			})
			setLiveSubtitleState(previousState => {
				if (previousState.activeSegmentId !== patch.itemId) return previousState
				return {
					activeSegmentId: null,
					isListening: previousState.isListening,
					text: '',
					updatedAt: Date.now()
				}
			})
		},
		[enqueueTranslateInput]
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
						setStatusMessage(null)
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
			},
			onRemoteStream: stream => {
				setRemoteAudioStream(stream)
			},
			onTranscriptPatch: patch => {
				setChatTranscripts(previousMessages => upsertChatTranscript(previousMessages, patch))
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
						if (
							modeRef.current === 'translate' &&
							subtitleClientRef.current &&
							subtitleClientRef.current.isConnected()
						) {
							setStatusMessage(null)
						}
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
			onError: message => {
				setErrorMessage(message)
			},
			onResultPatch: patch => {
				setTranslateCards(previousCards =>
					applyTranslateResultPatch(previousCards, patch, translateSettingsRef.current)
				)
			}
		})
		liveTranslateClientRef.current = translateClient
		void translateClient.start({
			model: defaultChatRealtimeModel,
			myLanguageCode: translateSettingsRef.current.myLanguageCode,
			translateToLanguageCode: translateSettingsRef.current.translateToLanguageCode
		})
	}, [clearReconnectTimer, flushPendingTranslateInputs, stopTranslateClient])

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
						if (
							modeRef.current === 'translate' &&
							liveTranslateClientRef.current &&
							liveTranslateClientRef.current.isConnected()
						) {
							setStatusMessage(null)
						}
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
			},
			onListeningStateChange: isListening => {
				setLiveSubtitleState(previousState => ({
					...previousState,
					isListening,
					updatedAt: Date.now()
				}))
			},
			onSubtitleDelta: patch => {
				setLiveSubtitleState(previousState => {
					if (previousState.activeSegmentId !== patch.itemId) {
						return {
							activeSegmentId: patch.itemId,
							isListening: true,
							text: patch.textDelta,
							updatedAt: Date.now()
						}
					}
					return {
						activeSegmentId: patch.itemId,
						isListening: true,
						text: `${previousState.text}${patch.textDelta}`,
						updatedAt: Date.now()
					}
				})
			},
			onSubtitleFinal: handleTranslateSubtitleFinalPatch
		})
		subtitleClientRef.current = subtitleClient
		void subtitleClient.start({
			myLanguageCode: translateSettingsRef.current.myLanguageCode,
			translateToLanguageCode: translateSettingsRef.current.translateToLanguageCode,
			voiceInputEnabled: voiceInputEnabledRef.current
		})
	}, [clearReconnectTimer, handleTranslateSubtitleFinalPatch, stopSubtitleClient])

	const startModeRuntime = useCallback(
		(nextMode: LilacMode) => {
			setErrorMessage(null)
			setStatusMessage(null)
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
			setStatusMessage('Reconnecting…')

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

	const setTranslateSettings = useCallback((nextSettings: TranslateSettings) => {
		const sanitizedSettings = sanitizeTranslateSettings(nextSettings)
		setTranslateSettingsState(sanitizedSettings)
		if (modeRef.current === 'translate') {
			liveTranslateClientRef.current?.updateTranslateSettings(sanitizedSettings)
			subtitleClientRef.current?.updateSubtitleSettings(sanitizedSettings)
		}
	}, [])

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
			setTranslateCards(previousCards => {
				const nextCard: UtteranceCard = {
					...createEmptyUtteranceCard(itemId, 'text', translateSettingsRef.current),
					sourceLanguageCode: translateSettingsRef.current.myLanguageCode,
					sourceText: normalizedText,
					status: 'translating'
				}
				const previousItemId =
					previousCards.length > 0 ? (previousCards[previousCards.length - 1]?.id ?? null) : null
				return insertCardByPreviousItemId(previousCards, nextCard, previousItemId)
			})
			enqueueTranslateInput({
				inputOrigin: 'text',
				itemId,
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
			setStatusMessage('Offline. Waiting for network…')
		}

		isOnlineRef.current = navigator.onLine
		window.addEventListener('online', handleOnline)
		window.addEventListener('offline', handleOffline)
		return () => {
			window.removeEventListener('online', handleOnline)
			window.removeEventListener('offline', handleOffline)
		}
	}, [chatChannelState, scheduleReconnect, subtitleChannelState, translateChannelState])

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
		}
	}, [])

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
