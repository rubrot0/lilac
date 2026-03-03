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

export type UtteranceDirection = 'my_to_target' | 'target_to_my'

export type UtteranceStatus = 'streaming' | 'translating' | 'final' | 'error'

export type UtteranceCard = {
	id: string
	sourceItemId: string
	responseId?: string
	inputOrigin: 'audio' | 'text'
	sourceText: string
	sourceLanguageCode: string
	translatedText: string
	targetLanguageCode: string
	direction: UtteranceDirection
	status: UtteranceStatus
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
	role: 'user' | 'assistant'
	text: string
	status: ChatTranscriptStatus
	source: ChatTranscriptSource
	createdAt: number
}
