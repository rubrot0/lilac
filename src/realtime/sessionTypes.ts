export type LilacMode = 'chat' | 'translate'

export type ModeConnectionState = 'idle' | 'connecting' | 'connected' | 'error'

export type GlobalAudioInputSettings = {
	voiceInputEnabled: boolean
}

export type ChatOutputSettings = {
	speechOutputEnabled: boolean
}

export type TranslateSettings = {
	myLanguageCode: string
	translateToLanguageCode: string
}

export type LanguageCatalogEntry = {
	code: string
	label: string
	nativeLabel?: string
	popular: boolean
}

export type LiveSubtitleState = {
	activeSegmentId: null | string
	isListening: boolean
	text: string
	updatedAt: number
}

export type SubtitleSegmentState = {
	segmentId: string
	previousSegmentId: null | string
	utteranceId: string
	draftText: string
	finalText: string
	committedAt: null | number
	confidence?: number
}

export type TranslateUtterancePhase = 'listening' | 'draft' | 'final' | 'error'

export type TranslateUtteranceState = {
	utteranceId: string
	previousUtteranceId: null | string
	orderedSegmentIds: string[]
	sourceLiveText: string
	sourceCommittedText: string
	draftTranslatedText: string
	finalTranslatedText: string
	phase: TranslateUtterancePhase
	inputOrigin: 'audio' | 'text'
	sourceLanguageCode: string
	targetLanguageCode: string
	direction: UtteranceDirection
	createdAt: number
	utteranceSequence: number
	draftSequence: number
	lastDraftAt?: number
	responseId?: string
	errorMessage?: string
}

export type TranslateRuntimeState = {
	activeAudioUtteranceId: null | string
	activeAudioUtteranceUpdatedAt: null | number
	lastAudioUtteranceId: null | string
	nextUtteranceSequence: number
	orderedUtteranceIds: string[]
	segmentById: Record<string, SubtitleSegmentState>
	utteranceById: Record<string, TranslateUtteranceState>
}

export type TranslateSegmentAggregationState = {
	activeUtteranceId: null | string
	lastFinalizedAt: null | number
	pendingSourceText: string
	sourceLanguageCode: null | string
}

export type ConnectionHealthState = {
	isReconnecting: boolean
	lastErrorAt: null | number
	subtitleConnected: boolean
	translateConnected: boolean
}

export type ConnectionUiState = {
	isLive: boolean
	isOffline: boolean
	isReconnecting: boolean
	lastHealthyAt: null | number
	statusMessage: null | string
}

export type UtteranceDirection = 'my_to_target' | 'target_to_my'

export type UtteranceStatus = 'streaming' | 'translating' | 'draft' | 'final' | 'error'

export type TranslateRenderState = 'listening' | 'draft' | 'final' | 'error'

export type UtteranceCard = {
	id: string
	sourceItemId: string
	responseId?: string
	inputOrigin: 'audio' | 'text'
	sourceText: string
	sourceLanguageCode: string
	translatedText: string
	draftTranslatedText?: string
	targetLanguageCode: string
	direction: UtteranceDirection
	renderState: TranslateRenderState
	status: UtteranceStatus
	draftSequence: number
	utteranceSequence: number
	lastDraftAt?: number
	createdAt: number
	errorMessage?: string
}

export type ChatTranscriptSource =
	| 'input_transcription'
	| 'input_text'
	| 'response_output_text'
	| 'response_output_audio_transcript'

export type ChatTranscriptStatus = 'streaming' | 'final'

export type ChatTranscriptMessage = {
	clientSequence: number
	id: string
	slotId?: string
	slotOrder?: number
	role: 'user' | 'assistant'
	text: string
	status: ChatTranscriptStatus
	source: ChatTranscriptSource
	createdAt: number
}

export type ChatTurnSlot = {
	slotId: string
	orderKey: number
	state: 'pending_user' | 'pending_assistant' | 'completed'
	userItemId: string
	assistantItemId?: string
}

export type ChatTimelineItem = {
	slotId: string
	clientSequence: number
	createdAt: number
	role: 'user' | 'assistant'
	streamState: ChatTranscriptStatus
	text: string
}
