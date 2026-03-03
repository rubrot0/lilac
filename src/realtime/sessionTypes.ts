export type LilacMode = 'chat' | 'translate'

export type ModeConnectionState = 'idle' | 'connecting' | 'connected' | 'error'

export type GlobalAudioInputSettings = {
	voiceInputEnabled: boolean
}

export type ChatOutputSettings = {
	speechOutputEnabled: boolean
}

export type TranslateSettings = {
	primaryLanguageCode: string
	secondaryLanguageCode: string
}

export type UtteranceDirection = 'primary_to_secondary' | 'secondary_to_primary'

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
	id: string
	role: 'user' | 'assistant'
	text: string
	status: ChatTranscriptStatus
	source: ChatTranscriptSource
	createdAt: number
}

export const languageOptions = [
	{ code: 'en', label: 'English' },
	{ code: 'es', label: 'Spanish' },
	{ code: 'fr', label: 'French' },
	{ code: 'de', label: 'German' },
	{ code: 'it', label: 'Italian' },
	{ code: 'pt', label: 'Portuguese' },
	{ code: 'zh', label: 'Chinese' },
	{ code: 'ja', label: 'Japanese' },
	{ code: 'ko', label: 'Korean' },
	{ code: 'ar', label: 'Arabic' },
	{ code: 'hi', label: 'Hindi' },
	{ code: 'ru', label: 'Russian' }
] as const

export function isKnownLanguageCode(languageCode: string): boolean {
	return languageOptions.some(option => option.code === languageCode)
}

export function normalizeLanguageCode(languageCode: string, fallbackLanguageCode: string): string {
	const normalizedCode = languageCode.trim().toLowerCase()
	if (!normalizedCode) return fallbackLanguageCode
	if (!isKnownLanguageCode(normalizedCode)) return fallbackLanguageCode
	return normalizedCode
}
