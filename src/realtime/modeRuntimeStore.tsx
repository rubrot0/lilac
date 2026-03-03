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
import {
	LiveTranslateRealtimeClient,
	type LiveTranslateResultPatch,
	type LiveTranslateSourcePatch
} from '@/realtime/liveTranslateRealtimeClient'
import { defaultChatRealtimeModel } from '@/realtime/modelConfig'
import type {
	ChatOutputSettings,
	ChatTranscriptMessage,
	GlobalAudioInputSettings,
	LilacMode,
	ModeConnectionState,
	TranslateSettings,
	UtteranceCard,
	UtteranceDirection
} from '@/realtime/sessionTypes'

const defaultChatInstructions =
	'You are Lilac. Help users communicate across languages. Keep answers concise, faithful, and practical.'

const defaultTranslateSettings: TranslateSettings = {
	primaryLanguageCode: 'en',
	secondaryLanguageCode: 'es'
}

const defaultGlobalAudioInputSettings: GlobalAudioInputSettings = {
	voiceInputEnabled: true
}

const defaultChatOutputSettings: ChatOutputSettings = {
	speechOutputEnabled: true
}

const storageKeys = {
	chatInstructions: 'lilac.chat.instructions',
	chatSpeechOutputEnabled: 'lilac.chat.speechOutputEnabled',
	chatTurnDelaySeconds: 'lilac.chat.turnDelaySeconds',
	mode: 'lilac.mode',
	translatePrimaryLanguage: 'lilac.translate.primaryLanguageCode',
	translateSecondaryLanguage: 'lilac.translate.secondaryLanguageCode',
	voiceInputEnabled: 'lilac.global.voiceInputEnabled'
} as const

function normalizeTurnDelaySeconds(value: unknown): number {
	const parsedValue = typeof value === 'number' ? value : Number.parseFloat(String(value))
	if (!Number.isFinite(parsedValue)) return 1.2
	const clampedValue = Math.min(6, Math.max(0.2, parsedValue))
	return Math.round(clampedValue * 10) / 10
}

function parseStoredBoolean(value: string | null, fallbackValue: boolean): boolean {
	if (value === 'true') return true
	if (value === 'false') return false
	return fallbackValue
}

function createEmptyUtteranceCard(
	itemId: string,
	inputOrigin: 'audio' | 'text',
	fallbackDirection: UtteranceDirection,
	translateSettings: TranslateSettings
): UtteranceCard {
	return {
		createdAt: Date.now(),
		direction: fallbackDirection,
		id: itemId,
		inputOrigin,
		sourceItemId: itemId,
		sourceLanguageCode: translateSettings.primaryLanguageCode,
		sourceText: '',
		status: 'streaming',
		targetLanguageCode:
			fallbackDirection === 'secondary_to_primary'
				? translateSettings.primaryLanguageCode
				: translateSettings.secondaryLanguageCode,
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

function upsertTranslateSourcePatch(
	cardList: UtteranceCard[],
	patch: LiveTranslateSourcePatch,
	translateSettings: TranslateSettings
): UtteranceCard[] {
	const existingCard = cardList.find(card => card.id === patch.itemId) ?? null
	const fallbackDirection =
		existingCard?.direction ??
		(patch.inputOrigin === 'text' ? 'primary_to_secondary' : 'primary_to_secondary')

	const sourceText =
		patch.status === 'final' ? patch.text : `${existingCard?.sourceText ?? ''}${patch.text}`

	const nextCard: UtteranceCard = {
		...(existingCard ??
			createEmptyUtteranceCard(patch.itemId, patch.inputOrigin, fallbackDirection, translateSettings)),
		inputOrigin: patch.inputOrigin,
		sourceText,
		status:
			patch.status === 'final'
				? existingCard?.status === 'final'
					? 'final'
					: 'translating'
				: 'streaming'
	}

	return insertCardByPreviousItemId(cardList, nextCard, patch.previousItemId)
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
		: createEmptyUtteranceCard(patch.itemId, patch.inputOrigin, patch.direction, translateSettings)
	const nextCard: UtteranceCard = {
		...baseCard,
		direction: patch.direction,
		inputOrigin: patch.inputOrigin,
		sourceLanguageCode: patch.sourceLanguageCode,
		sourceText: patch.sourceText.trim() ? patch.sourceText : (existingCard?.sourceText ?? ''),
		status: patch.status,
		targetLanguageCode: patch.targetLanguageCode,
		translatedText: patch.translatedText,
		...(patch.status === 'error' ? { errorMessage: patch.translatedText } : {}),
		...(patch.responseId ? { responseId: patch.responseId } : {})
	}
	return insertCardByPreviousItemId(cardList, nextCard)
}

function getDirectionColorClass(direction: UtteranceDirection): string {
	switch (direction) {
		case 'primary_to_secondary':
			return 'var(--lilac-direction-primary)'
		case 'secondary_to_primary':
			return 'var(--lilac-direction-secondary)'
		default:
			return 'var(--lilac-ink-muted)'
	}
}

type LilacModeRuntimeContextValue = {
	chatInstructions: string
	chatSpeechOutputEnabled: boolean
	chatTranscripts: ChatTranscriptMessage[]
	chatTurnDelaySeconds: number
	clearCurrentModeHistory: () => void
	connectionState: ModeConnectionState
	errorMessage: null | string
	getDirectionColor: (direction: UtteranceDirection) => string
	mode: LilacMode
	reconnectCurrentMode: () => void
	remoteAudioStream: MediaStream | null
	setChatInstructions: (instructions: string) => void
	setChatSpeechOutputEnabled: (speechOutputEnabled: boolean) => void
	setChatTurnDelaySeconds: (seconds: number) => void
	setMode: (mode: LilacMode) => void
	setTranslateSettings: (nextSettings: TranslateSettings) => void
	setVoiceInputEnabled: (voiceInputEnabled: boolean) => void
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
	const [chatInstructions, setChatInstructionsState] = useState(defaultChatInstructions)
	const [chatTurnDelaySeconds, setChatTurnDelaySecondsState] = useState(1.2)
	const [chatTranscripts, setChatTranscripts] = useState<ChatTranscriptMessage[]>([])
	const [translateSettings, setTranslateSettingsState] =
		useState<TranslateSettings>(defaultTranslateSettings)
	const [translateCards, setTranslateCards] = useState<UtteranceCard[]>([])
	const [globalAudioInputSettings, setGlobalAudioInputSettings] = useState<GlobalAudioInputSettings>(
		defaultGlobalAudioInputSettings
	)
	const [chatOutputSettings, setChatOutputSettings] =
		useState<ChatOutputSettings>(defaultChatOutputSettings)
	const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null)
	const [isHydrated, setIsHydrated] = useState(false)
	const [restartNonce, setRestartNonce] = useState(0)

	const chatClientRef = useRef<ChatRealtimeClient | null>(null)
	const liveTranslateClientRef = useRef<LiveTranslateRealtimeClient | null>(null)

	const chatInstructionsRef = useRef(chatInstructions)
	const chatTurnDelaySecondsRef = useRef(chatTurnDelaySeconds)
	const translateSettingsRef = useRef(translateSettings)
	const voiceInputEnabledRef = useRef(globalAudioInputSettings.voiceInputEnabled)
	const chatSpeechOutputEnabledRef = useRef(chatOutputSettings.speechOutputEnabled)

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

	const stopAllClients = useCallback(() => {
		chatClientRef.current?.stop()
		chatClientRef.current = null
		liveTranslateClientRef.current?.stop()
		liveTranslateClientRef.current = null
		setRemoteAudioStream(null)
	}, [])

	const clearAllInMemoryState = useCallback(() => {
		setChatTranscripts([])
		setTranslateCards([])
	}, [])

	const clearStateForMode = useCallback((nextMode: LilacMode) => {
		switch (nextMode) {
			case 'chat':
				setChatTranscripts([])
				return
			case 'translate':
				setTranslateCards([])
				return
			default:
				return
		}
	}, [])

	const startChatClient = useCallback(() => {
		stopAllClients()
		const chatClient = new ChatRealtimeClient({
			onConnectionStateChange: state => {
				switch (state) {
					case 'connected':
						setConnectionState('connected')
						setErrorMessage(null)
						return
					case 'connecting':
						setConnectionState('connecting')
						return
					case 'disconnected':
						setConnectionState('idle')
						return
					case 'error':
						setConnectionState('error')
						return
					default:
						return
				}
			},
			onError: message => {
				setErrorMessage(message)
				setConnectionState('error')
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
	}, [stopAllClients])

	const startLiveTranslateClient = useCallback(() => {
		stopAllClients()
		const translateClient = new LiveTranslateRealtimeClient({
			onConnectionStateChange: state => {
				switch (state) {
					case 'connected':
						setConnectionState('connected')
						setErrorMessage(null)
						return
					case 'connecting':
						setConnectionState('connecting')
						return
					case 'disconnected':
						setConnectionState('idle')
						return
					case 'error':
						setConnectionState('error')
						return
					default:
						return
				}
			},
			onError: message => {
				setErrorMessage(message)
				setConnectionState('error')
			},
			onResultPatch: patch => {
				setTranslateCards(previousCards =>
					applyTranslateResultPatch(previousCards, patch, translateSettingsRef.current)
				)
			},
			onSourcePatch: patch => {
				setTranslateCards(previousCards =>
					upsertTranslateSourcePatch(previousCards, patch, translateSettingsRef.current)
				)
			}
		})
		liveTranslateClientRef.current = translateClient
		void translateClient.start({
			model: defaultChatRealtimeModel,
			primaryLanguageCode: translateSettingsRef.current.primaryLanguageCode,
			secondaryLanguageCode: translateSettingsRef.current.secondaryLanguageCode,
			turnDelaySeconds: chatTurnDelaySecondsRef.current,
			voiceInputEnabled: voiceInputEnabledRef.current
		})
	}, [stopAllClients])

	const startModeRuntime = useCallback(
		(nextMode: LilacMode) => {
			setErrorMessage(null)
			setConnectionState('connecting')
			switch (nextMode) {
				case 'chat':
					startChatClient()
					return
				case 'translate':
					startLiveTranslateClient()
					return
				default:
					return
			}
		},
		[startChatClient, startLiveTranslateClient]
	)

	const setMode = useCallback(
		(nextMode: LilacMode) => {
			if (nextMode === mode) return
			stopAllClients()
			clearAllInMemoryState()
			setModeState(nextMode)
		},
		[clearAllInMemoryState, mode, stopAllClients]
	)

	const reconnectCurrentMode = useCallback(() => {
		stopAllClients()
		clearStateForMode(mode)
		setRestartNonce(previousNonce => previousNonce + 1)
	}, [clearStateForMode, mode, stopAllClients])

	const clearCurrentModeHistory = useCallback(() => {
		clearStateForMode(mode)
	}, [clearStateForMode, mode])

	const setChatInstructions = useCallback((instructions: string) => {
		setChatInstructionsState(instructions)
	}, [])

	const setChatTurnDelaySeconds = useCallback((seconds: number) => {
		setChatTurnDelaySecondsState(normalizeTurnDelaySeconds(seconds))
	}, [])

	const setTranslateSettings = useCallback(
		(nextSettings: TranslateSettings) => {
			setTranslateSettingsState(nextSettings)
			if (mode === 'translate') {
				liveTranslateClientRef.current?.updateTranslateSettings({
					primaryLanguageCode: nextSettings.primaryLanguageCode,
					secondaryLanguageCode: nextSettings.secondaryLanguageCode,
					turnDelaySeconds: chatTurnDelaySecondsRef.current
				})
			}
		},
		[mode]
	)

	const setVoiceInputEnabled = useCallback(
		(voiceInputEnabled: boolean) => {
			setGlobalAudioInputSettings({ voiceInputEnabled })
			switch (mode) {
				case 'chat':
					void chatClientRef.current?.updateVoiceInputEnabled(voiceInputEnabled)
					return
				case 'translate':
					void liveTranslateClientRef.current?.updateVoiceInputEnabled(voiceInputEnabled)
					return
				default:
					return
			}
		},
		[mode]
	)

	const setChatSpeechOutputEnabled = useCallback(
		(speechOutputEnabled: boolean) => {
			setChatOutputSettings({ speechOutputEnabled })
			if (mode === 'chat') {
				chatClientRef.current?.updateSpeechOutputEnabled(speechOutputEnabled)
			}
		},
		[mode]
	)

	const submitChatTextInput = useCallback((text: string) => {
		chatClientRef.current?.submitTextInput(text)
	}, [])

	const submitTranslateTextInput = useCallback((text: string) => {
		liveTranslateClientRef.current?.submitTextInput(text)
	}, [])

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

		const storedTranslatePrimaryLanguageCode = window.localStorage.getItem(
			storageKeys.translatePrimaryLanguage
		)
		const storedTranslateSecondaryLanguageCode = window.localStorage.getItem(
			storageKeys.translateSecondaryLanguage
		)
		if (storedTranslatePrimaryLanguageCode && storedTranslateSecondaryLanguageCode) {
			setTranslateSettingsState({
				primaryLanguageCode: storedTranslatePrimaryLanguageCode,
				secondaryLanguageCode: storedTranslateSecondaryLanguageCode
			})
		}

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
	}, [])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(storageKeys.mode, mode)
	}, [isHydrated, mode])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(storageKeys.chatInstructions, chatInstructions)
		if (mode === 'chat') chatClientRef.current?.updateInstructions(chatInstructions)
	}, [chatInstructions, isHydrated, mode])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(storageKeys.chatTurnDelaySeconds, String(chatTurnDelaySeconds))
		switch (mode) {
			case 'chat':
				chatClientRef.current?.updateTurnDelaySeconds(chatTurnDelaySeconds)
				return
			case 'translate':
				liveTranslateClientRef.current?.updateTranslateSettings({
					primaryLanguageCode: translateSettings.primaryLanguageCode,
					secondaryLanguageCode: translateSettings.secondaryLanguageCode,
					turnDelaySeconds: chatTurnDelaySeconds
				})
				return
			default:
				return
		}
	}, [
		chatTurnDelaySeconds,
		isHydrated,
		mode,
		translateSettings.primaryLanguageCode,
		translateSettings.secondaryLanguageCode
	])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(
			storageKeys.translatePrimaryLanguage,
			translateSettings.primaryLanguageCode
		)
		window.localStorage.setItem(
			storageKeys.translateSecondaryLanguage,
			translateSettings.secondaryLanguageCode
		)
	}, [isHydrated, translateSettings.primaryLanguageCode, translateSettings.secondaryLanguageCode])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(
			storageKeys.voiceInputEnabled,
			String(globalAudioInputSettings.voiceInputEnabled)
		)
		switch (mode) {
			case 'chat':
				void chatClientRef.current?.updateVoiceInputEnabled(globalAudioInputSettings.voiceInputEnabled)
				return
			case 'translate':
				void liveTranslateClientRef.current?.updateVoiceInputEnabled(
					globalAudioInputSettings.voiceInputEnabled
				)
				return
			default:
				return
		}
	}, [globalAudioInputSettings.voiceInputEnabled, isHydrated, mode])

	useEffect(() => {
		if (!isHydrated) return
		window.localStorage.setItem(
			storageKeys.chatSpeechOutputEnabled,
			String(chatOutputSettings.speechOutputEnabled)
		)
		if (mode === 'chat') {
			chatClientRef.current?.updateSpeechOutputEnabled(chatOutputSettings.speechOutputEnabled)
		}
	}, [chatOutputSettings.speechOutputEnabled, isHydrated, mode])

	useEffect(() => {
		if (!isHydrated) return
		void restartNonce
		startModeRuntime(mode)
		return () => {
			stopAllClients()
		}
	}, [isHydrated, mode, restartNonce, startModeRuntime, stopAllClients])

	const contextValue = useMemo<LilacModeRuntimeContextValue>(
		() => ({
			chatInstructions,
			chatSpeechOutputEnabled: chatOutputSettings.speechOutputEnabled,
			chatTranscripts,
			chatTurnDelaySeconds,
			clearCurrentModeHistory,
			connectionState,
			errorMessage,
			getDirectionColor: getDirectionColorClass,
			mode,
			reconnectCurrentMode,
			remoteAudioStream,
			setChatInstructions,
			setChatSpeechOutputEnabled,
			setChatTurnDelaySeconds,
			setMode,
			setTranslateSettings,
			setVoiceInputEnabled,
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
			clearCurrentModeHistory,
			connectionState,
			errorMessage,
			mode,
			reconnectCurrentMode,
			remoteAudioStream,
			setChatInstructions,
			setChatSpeechOutputEnabled,
			setChatTurnDelaySeconds,
			setMode,
			setTranslateSettings,
			setVoiceInputEnabled,
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
