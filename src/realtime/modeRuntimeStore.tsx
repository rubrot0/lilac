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

import { compactTranslationContextAction, translateUtteranceAction } from '@/app/actions/realtime'
import { ChatRealtimeClient, type ChatTranscriptPatch } from '@/realtime/chatRealtimeClient'
import type {
	ChatTranscriptMessage,
	LilacMode,
	ModeConnectionState,
	TranscribeSettings,
	TranslateSettings,
	TranslationContextEntry,
	UtteranceCard,
	UtteranceDirection
} from '@/realtime/sessionTypes'
import {
	type TranscriptionPatch,
	TranscriptionSocketClient
} from '@/realtime/transcriptionSocketClient'

const defaultChatInstructions =
	'You are Lilac. Help users communicate across languages. Keep answers concise, faithful, and practical.'

const defaultTranslateSettings: TranslateSettings = {
	primaryLanguageCode: 'en',
	secondaryLanguageCode: 'es'
}

const defaultTranscribeSettings: TranscribeSettings = {
	targetLanguageCode: 'en'
}

const storageKeys = {
	chatInstructions: 'lilac.chat.instructions',
	chatTurnDelaySeconds: 'lilac.chat.turnDelaySeconds',
	mode: 'lilac.mode',
	transcribeTargetLanguage: 'lilac.transcribe.targetLanguageCode',
	translatePrimaryLanguage: 'lilac.translate.primaryLanguageCode',
	translateSecondaryLanguage: 'lilac.translate.secondaryLanguageCode'
} as const

function normalizeTurnDelaySeconds(value: unknown): number {
	const parsedValue = typeof value === 'number' ? value : Number.parseFloat(String(value))
	if (!Number.isFinite(parsedValue)) return 1.2
	const clampedValue = Math.min(6, Math.max(0.2, parsedValue))
	return Math.round(clampedValue * 10) / 10
}

function createEmptyUtteranceCard(id: string, direction: UtteranceDirection): UtteranceCard {
	return {
		createdAt: Date.now(),
		direction,
		id,
		sourceLanguageCode: 'und',
		sourceText: '',
		status: 'streaming',
		targetLanguageCode: 'und',
		translatedText: ''
	}
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

function upsertStreamingCard(
	existingList: UtteranceCard[],
	patch: TranscriptionPatch,
	fallbackDirection: UtteranceDirection
): UtteranceCard[] {
	const existingIndex = existingList.findIndex(item => item.id === patch.itemId)
	const existingItem = existingIndex >= 0 ? existingList[existingIndex] : null

	const mergedText =
		patch.status === 'final' ? patch.text : `${existingItem?.sourceText ?? ''}${patch.text || ''}`

	const nextItem: UtteranceCard = {
		...(existingItem ?? createEmptyUtteranceCard(patch.itemId, fallbackDirection)),
		sourceText: mergedText,
		status: patch.status === 'final' ? 'translating' : 'streaming'
	}

	if (existingIndex === -1) {
		return [...existingList, nextItem]
	}

	const nextList = existingList.slice()
	nextList[existingIndex] = nextItem
	return nextList
}

function buildTranslationContextFromCards(cards: UtteranceCard[]): TranslationContextEntry[] {
	const finalCards = cards.filter(
		card => card.status === 'final' && card.translatedText.trim().length > 0
	)
	const boundedFinalCards = finalCards.slice(Math.max(0, finalCards.length - 200))

	return boundedFinalCards.map(card => ({
		direction: card.direction,
		sourceLanguageCode: card.sourceLanguageCode,
		sourceText: card.sourceText,
		targetLanguageCode: card.targetLanguageCode,
		translatedText: card.translatedText
	}))
}

function getDirectionColorClass(direction: UtteranceDirection): string {
	switch (direction) {
		case 'primary_to_secondary':
			return 'var(--lilac-direction-primary)'
		case 'secondary_to_primary':
			return 'var(--lilac-direction-secondary)'
		case 'to_target':
			return 'var(--lilac-direction-transcribe)'
		default:
			return 'var(--lilac-ink-muted)'
	}
}

type LilacModeRuntimeContextValue = {
	chatInstructions: string
	chatTranscripts: ChatTranscriptMessage[]
	chatTurnDelaySeconds: number
	clearCurrentModeHistory: () => void
	connectionState: ModeConnectionState
	errorMessage: string | null
	getDirectionColor: (direction: UtteranceDirection) => string
	mode: LilacMode
	reconnectCurrentMode: () => void
	remoteAudioStream: MediaStream | null
	setChatInstructions: (instructions: string) => void
	setChatTurnDelaySeconds: (seconds: number) => void
	setMode: (mode: LilacMode) => void
	setTranscribeSettings: (nextSettings: TranscribeSettings) => void
	setTranslateSettings: (nextSettings: TranslateSettings) => void
	transcribeCards: UtteranceCard[]
	transcribeSettings: TranscribeSettings
	translateCards: UtteranceCard[]
	translateSettings: TranslateSettings
}

const LilacModeRuntimeContext = createContext<LilacModeRuntimeContextValue | null>(null)

export function LilacModeRuntimeProvider({ children }: { children: ReactNode }) {
	const [mode, setModeState] = useState<LilacMode>('chat')
	const [connectionState, setConnectionState] = useState<ModeConnectionState>('idle')
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [chatInstructions, setChatInstructionsState] = useState(defaultChatInstructions)
	const [chatTurnDelaySeconds, setChatTurnDelaySecondsState] = useState(1.2)
	const [chatTranscripts, setChatTranscripts] = useState<ChatTranscriptMessage[]>([])
	const [translateSettings, setTranslateSettingsState] =
		useState<TranslateSettings>(defaultTranslateSettings)
	const [translateCards, setTranslateCards] = useState<UtteranceCard[]>([])
	const [transcribeSettings, setTranscribeSettingsState] =
		useState<TranscribeSettings>(defaultTranscribeSettings)
	const [transcribeCards, setTranscribeCards] = useState<UtteranceCard[]>([])
	const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null)
	const [isHydrated, setIsHydrated] = useState(false)
	const [restartNonce, setRestartNonce] = useState(0)

	const chatClientRef = useRef<ChatRealtimeClient | null>(null)
	const transcriptionClientRef = useRef<TranscriptionSocketClient | null>(null)
	const translateCardsRef = useRef<UtteranceCard[]>([])
	const transcribeCardsRef = useRef<UtteranceCard[]>([])
	const translationGenerationRef = useRef(0)

	useEffect(() => {
		translateCardsRef.current = translateCards
	}, [translateCards])

	useEffect(() => {
		transcribeCardsRef.current = transcribeCards
	}, [transcribeCards])

	const stopAllClients = useCallback(() => {
		chatClientRef.current?.stop()
		chatClientRef.current = null
		transcriptionClientRef.current?.stop()
		transcriptionClientRef.current = null
		setRemoteAudioStream(null)
	}, [])

	const clearAllInMemoryState = useCallback(() => {
		setChatTranscripts([])
		setTranslateCards([])
		setTranscribeCards([])
	}, [])

	const clearStateForMode = useCallback((nextMode: LilacMode) => {
		switch (nextMode) {
			case 'chat':
				setChatTranscripts([])
				return
			case 'translate':
				setTranslateCards([])
				return
			case 'transcribe':
				setTranscribeCards([])
				return
			default:
				return
		}
	}, [])

	const runTranslationForCard = useCallback(
		async (currentMode: 'translate' | 'transcribe', cardId: string, sourceText: string) => {
			const generationAtStart = translationGenerationRef.current
			try {
				if (currentMode === 'translate') {
					const compactedContext = await compactTranslationContextAction({
						context: buildTranslationContextFromCards(translateCardsRef.current)
					})
					const output = await translateUtteranceAction({
						context: compactedContext.compactedContext,
						settings: {
							mode: 'translate',
							primaryLanguageCode: translateSettings.primaryLanguageCode,
							secondaryLanguageCode: translateSettings.secondaryLanguageCode
						},
						utteranceText: sourceText
					})

					if (generationAtStart !== translationGenerationRef.current) return

					setTranslateCards(previousCards => {
						const cardIndex = previousCards.findIndex(card => card.id === cardId)
						if (cardIndex === -1) return previousCards
						const nextCards = previousCards.slice()
						const existingCard = nextCards[cardIndex]
						if (!existingCard) return previousCards
						nextCards[cardIndex] = {
							...existingCard,
							direction: output.direction,
							sourceLanguageCode: output.detectedSourceLanguageCode,
							status: 'final',
							targetLanguageCode: output.targetLanguageCode,
							translatedText: output.translatedText
						}
						return nextCards
					})
					return
				}

				const compactedContext = await compactTranslationContextAction({
					context: buildTranslationContextFromCards(transcribeCardsRef.current)
				})
				const output = await translateUtteranceAction({
					context: compactedContext.compactedContext,
					settings: {
						mode: 'transcribe',
						targetLanguageCode: transcribeSettings.targetLanguageCode
					},
					utteranceText: sourceText
				})

				if (generationAtStart !== translationGenerationRef.current) return

				setTranscribeCards(previousCards => {
					const cardIndex = previousCards.findIndex(card => card.id === cardId)
					if (cardIndex === -1) return previousCards
					const nextCards = previousCards.slice()
					const existingCard = nextCards[cardIndex]
					if (!existingCard) return previousCards
					nextCards[cardIndex] = {
						...existingCard,
						direction: output.direction,
						sourceLanguageCode: output.detectedSourceLanguageCode,
						status: 'final',
						targetLanguageCode: output.targetLanguageCode,
						translatedText: output.translatedText
					}
					return nextCards
				})
			} catch (error) {
				if (generationAtStart !== translationGenerationRef.current) return
				const message = error instanceof Error ? error.message : 'Translation failed'
				switch (currentMode) {
					case 'translate':
						setTranslateCards(previousCards => {
							const cardIndex = previousCards.findIndex(card => card.id === cardId)
							if (cardIndex === -1) return previousCards
							const nextCards = previousCards.slice()
							const existingCard = nextCards[cardIndex]
							if (!existingCard) return previousCards
							nextCards[cardIndex] = {
								...existingCard,
								errorMessage: message,
								status: 'error'
							}
							return nextCards
						})
						return
					case 'transcribe':
						setTranscribeCards(previousCards => {
							const cardIndex = previousCards.findIndex(card => card.id === cardId)
							if (cardIndex === -1) return previousCards
							const nextCards = previousCards.slice()
							const existingCard = nextCards[cardIndex]
							if (!existingCard) return previousCards
							nextCards[cardIndex] = {
								...existingCard,
								errorMessage: message,
								status: 'error'
							}
							return nextCards
						})
						return
					default:
						return
				}
			}
		},
		[
			transcribeSettings.targetLanguageCode,
			translateSettings.primaryLanguageCode,
			translateSettings.secondaryLanguageCode
		]
	)

	const handleTranscriptionPatch = useCallback(
		(currentMode: 'translate' | 'transcribe', patch: TranscriptionPatch) => {
			const fallbackDirection: UtteranceDirection =
				currentMode === 'translate' ? 'primary_to_secondary' : 'to_target'

			switch (currentMode) {
				case 'translate': {
					setTranslateCards(previousCards =>
						upsertStreamingCard(previousCards, patch, fallbackDirection)
					)
					if (patch.status === 'final' && patch.text.trim().length > 0) {
						void runTranslationForCard('translate', patch.itemId, patch.text)
					}
					return
				}
				case 'transcribe': {
					setTranscribeCards(previousCards =>
						upsertStreamingCard(previousCards, patch, fallbackDirection)
					)
					if (patch.status === 'final' && patch.text.trim().length > 0) {
						void runTranslationForCard('transcribe', patch.itemId, patch.text)
					}
					return
				}
				default:
					return
			}
		},
		[runTranslationForCard]
	)

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
			instructions: chatInstructions,
			model: 'gpt-realtime',
			turnDelaySeconds: chatTurnDelaySeconds,
			voice: 'verse'
		})
	}, [chatInstructions, chatTurnDelaySeconds, stopAllClients])

	const startTranscriptionClient = useCallback(
		(currentMode: 'translate' | 'transcribe') => {
			stopAllClients()
			const transcriptionClient = new TranscriptionSocketClient({
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
				onPatch: patch => {
					handleTranscriptionPatch(currentMode, patch)
				}
			})
			transcriptionClientRef.current = transcriptionClient
			void transcriptionClient.start({
				model: 'gpt-4o-transcribe',
				turnDelaySeconds: chatTurnDelaySeconds,
				...(currentMode === 'transcribe' ? { languageHint: transcribeSettings.targetLanguageCode } : {})
			})
		},
		[
			chatTurnDelaySeconds,
			handleTranscriptionPatch,
			stopAllClients,
			transcribeSettings.targetLanguageCode
		]
	)

	const startModeRuntime = useCallback(
		(nextMode: LilacMode) => {
			setErrorMessage(null)
			setConnectionState('connecting')
			switch (nextMode) {
				case 'chat':
					startChatClient()
					return
				case 'translate':
					startTranscriptionClient('translate')
					return
				case 'transcribe':
					startTranscriptionClient('transcribe')
					return
				default:
					return
			}
		},
		[startChatClient, startTranscriptionClient]
	)

	const setMode = useCallback(
		(nextMode: LilacMode) => {
			translationGenerationRef.current += 1
			stopAllClients()
			clearAllInMemoryState()
			setModeState(nextMode)
		},
		[clearAllInMemoryState, stopAllClients]
	)

	const reconnectCurrentMode = useCallback(() => {
		translationGenerationRef.current += 1
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

	const setTranslateSettings = useCallback((nextSettings: TranslateSettings) => {
		setTranslateSettingsState(nextSettings)
	}, [])

	const setTranscribeSettings = useCallback((nextSettings: TranscribeSettings) => {
		setTranscribeSettingsState(nextSettings)
	}, [])

	useEffect(() => {
		if (typeof window === 'undefined') return

		const storedMode = window.localStorage.getItem(storageKeys.mode)
		if (storedMode === 'chat' || storedMode === 'translate' || storedMode === 'transcribe') {
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

		const storedTranscribeTargetLanguageCode = window.localStorage.getItem(
			storageKeys.transcribeTargetLanguage
		)
		if (storedTranscribeTargetLanguageCode) {
			setTranscribeSettingsState({ targetLanguageCode: storedTranscribeTargetLanguageCode })
		}

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
		if (mode === 'chat') chatClientRef.current?.updateTurnDelaySeconds(chatTurnDelaySeconds)
	}, [chatTurnDelaySeconds, isHydrated, mode])

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
			storageKeys.transcribeTargetLanguage,
			transcribeSettings.targetLanguageCode
		)
	}, [isHydrated, transcribeSettings.targetLanguageCode])

	useEffect(() => {
		if (!isHydrated) return
		void restartNonce
		translationGenerationRef.current += 1
		startModeRuntime(mode)
		return () => {
			stopAllClients()
		}
	}, [isHydrated, mode, restartNonce, startModeRuntime, stopAllClients])

	const contextValue = useMemo<LilacModeRuntimeContextValue>(
		() => ({
			chatInstructions,
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
			setChatTurnDelaySeconds,
			setMode,
			setTranscribeSettings,
			setTranslateSettings,
			transcribeCards,
			transcribeSettings,
			translateCards,
			translateSettings
		}),
		[
			chatInstructions,
			chatTranscripts,
			chatTurnDelaySeconds,
			clearCurrentModeHistory,
			connectionState,
			errorMessage,
			mode,
			reconnectCurrentMode,
			remoteAudioStream,
			setChatInstructions,
			setChatTurnDelaySeconds,
			setMode,
			setTranscribeSettings,
			setTranslateSettings,
			transcribeCards,
			transcribeSettings,
			translateCards,
			translateSettings
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
