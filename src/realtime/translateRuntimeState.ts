import type {
	LiveTranslateDraftPatch,
	LiveTranslateResultPatch
} from '@/realtime/liveTranslateRealtimeClient'
import type {
	LiveSubtitleState,
	TranslateRuntimeState,
	TranslateSettings,
	TranslateUtteranceState,
	UtteranceCard
} from '@/realtime/sessionTypes'
import type { SubtitleDeltaPatch, SubtitleFinalPatch } from '@/realtime/subtitleTranscriptionClient'

type AudioSegmentEvent = Pick<SubtitleDeltaPatch, 'itemId' | 'previousItemId'> & {
	text: string
}

type ResolveAudioUtteranceResult = {
	nextState: TranslateRuntimeState
	previousUtteranceId: null | string
	utteranceId: string
}

const audioUtteranceReuseThresholdMilliseconds = 2200

export function createTranslateRuntimeState(): TranslateRuntimeState {
	return {
		activeAudioUtteranceId: null,
		activeAudioUtteranceUpdatedAt: null,
		lastAudioUtteranceId: null,
		nextUtteranceSequence: 1,
		orderedUtteranceIds: [],
		segmentById: {},
		utteranceById: {}
	}
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

function findWordOverlapLength(existingText: string, nextText: string): number {
	const existingWordList = existingText.split(' ')
	const nextWordList = nextText.split(' ')
	const maxOverlapLength = Math.min(existingWordList.length, nextWordList.length)
	for (let overlapLength = maxOverlapLength; overlapLength >= 1; overlapLength -= 1) {
		const existingSuffix = existingWordList.slice(-overlapLength).join(' ').toLowerCase()
		const nextPrefix = nextWordList.slice(0, overlapLength).join(' ').toLowerCase()
		if (existingSuffix === nextPrefix) return overlapLength
	}
	return 0
}

function mergeUtteranceText(existingText: string, nextChunkText: string): string {
	const normalizedExistingText = normalizeWhitespace(existingText)
	const normalizedChunkText = normalizeWhitespace(nextChunkText)
	if (!normalizedChunkText) return normalizedExistingText
	if (!normalizedExistingText) return normalizedChunkText
	if (isEquivalentTranscriptionChunk(normalizedExistingText, normalizedChunkText)) {
		return normalizedExistingText
	}
	if (normalizedExistingText.toLowerCase().endsWith(normalizedChunkText.toLowerCase())) {
		return normalizedExistingText
	}
	if (normalizedChunkText.toLowerCase().startsWith(normalizedExistingText.toLowerCase())) {
		return normalizedChunkText
	}
	const overlapLength = findWordOverlapLength(normalizedExistingText, normalizedChunkText)
	if (overlapLength > 0) {
		const chunkWordList = normalizedChunkText.split(' ')
		const suffixWordList = chunkWordList.slice(overlapLength)
		if (suffixWordList.length === 0) return normalizedExistingText
		return `${normalizedExistingText} ${suffixWordList.join(' ')}`
	}
	return `${normalizedExistingText} ${normalizedChunkText}`
}

function createAudioUtterance(
	state: TranslateRuntimeState,
	input: {
		createdAt: number
		inputOrigin: 'audio' | 'text'
		previousUtteranceId: null | string
		settings: TranslateSettings
		utteranceId: string
	}
): TranslateRuntimeState {
	const nextUtterance: TranslateUtteranceState = {
		createdAt: input.createdAt,
		direction: 'my_to_target',
		draftSequence: 0,
		draftTranslatedText: '',
		finalTranslatedText: '',
		inputOrigin: input.inputOrigin,
		orderedSegmentIds: [],
		phase: 'listening',
		previousUtteranceId: input.previousUtteranceId,
		sourceCommittedText: '',
		sourceLanguageCode: input.settings.myLanguageCode,
		sourceLiveText: '',
		targetLanguageCode: input.settings.translateToLanguageCode,
		utteranceId: input.utteranceId,
		utteranceSequence: state.nextUtteranceSequence
	}
	return {
		...state,
		nextUtteranceSequence: state.nextUtteranceSequence + 1,
		orderedUtteranceIds: insertOrderedId(
			state.orderedUtteranceIds,
			input.utteranceId,
			input.previousUtteranceId
		),
		utteranceById: {
			...state.utteranceById,
			[input.utteranceId]: nextUtterance
		}
	}
}

function insertOrderedId(
	orderedIdList: string[],
	nextId: string,
	previousId: null | string
): string[] {
	const filteredIdList = orderedIdList.filter(id => id !== nextId)
	if (!previousId) return [...filteredIdList, nextId]
	const previousIndex = filteredIdList.indexOf(previousId)
	if (previousIndex === -1) return [...filteredIdList, nextId]
	return [
		...filteredIdList.slice(0, previousIndex + 1),
		nextId,
		...filteredIdList.slice(previousIndex + 1)
	]
}

function insertSegmentId(
	orderedSegmentIds: string[],
	segmentId: string,
	previousSegmentId: null | string
): string[] {
	const filteredSegmentIds = orderedSegmentIds.filter(id => id !== segmentId)
	if (!previousSegmentId) return [...filteredSegmentIds, segmentId]
	const previousIndex = filteredSegmentIds.indexOf(previousSegmentId)
	if (previousIndex === -1) return [...filteredSegmentIds, segmentId]
	return [
		...filteredSegmentIds.slice(0, previousIndex + 1),
		segmentId,
		...filteredSegmentIds.slice(previousIndex + 1)
	]
}

function composeUtteranceText(
	state: TranslateRuntimeState,
	utteranceId: string,
	textSelector: (input: { draftText: string; finalText: string }) => string
): string {
	const utterance = state.utteranceById[utteranceId]
	if (!utterance) return ''
	let composedText = ''
	for (const segmentId of utterance.orderedSegmentIds) {
		const segment = state.segmentById[segmentId]
		if (!segment) continue
		const nextText = normalizeWhitespace(
			textSelector({ draftText: segment.draftText, finalText: segment.finalText })
		)
		if (!nextText) continue
		composedText = mergeUtteranceText(composedText, nextText)
	}
	return normalizeWhitespace(composedText)
}

function refreshUtteranceSourceText(
	state: TranslateRuntimeState,
	utteranceId: string
): TranslateRuntimeState {
	const utterance = state.utteranceById[utteranceId]
	if (!utterance) return state
	const sourceCommittedText = composeUtteranceText(state, utteranceId, ({ finalText }) => finalText)
	const sourceLiveText = composeUtteranceText(
		state,
		utteranceId,
		({ draftText, finalText }) => finalText || draftText
	)
	return {
		...state,
		utteranceById: {
			...state.utteranceById,
			[utteranceId]: {
				...utterance,
				sourceCommittedText,
				sourceLiveText
			}
		}
	}
}

function resolveAudioUtteranceForSegment(
	state: TranslateRuntimeState,
	input: AudioSegmentEvent & {
		now: number
		settings: TranslateSettings
	}
): ResolveAudioUtteranceResult {
	const existingSegment = state.segmentById[input.itemId]
	if (existingSegment) {
		const existingUtterance = state.utteranceById[existingSegment.utteranceId]
		return {
			nextState: state,
			previousUtteranceId: existingUtterance?.previousUtteranceId ?? null,
			utteranceId: existingSegment.utteranceId
		}
	}

	const previousSegment = input.previousItemId ? state.segmentById[input.previousItemId] : undefined
	const activeAudioUtterance =
		state.activeAudioUtteranceId && state.activeAudioUtteranceUpdatedAt
			? {
					updatedAt: state.activeAudioUtteranceUpdatedAt,
					utteranceId: state.activeAudioUtteranceId
				}
			: null
	const shouldReuseActiveUtterance =
		activeAudioUtterance !== null &&
		input.now - activeAudioUtterance.updatedAt <= audioUtteranceReuseThresholdMilliseconds &&
		(!previousSegment || previousSegment.utteranceId === activeAudioUtterance.utteranceId)

	if (shouldReuseActiveUtterance && activeAudioUtterance) {
		const utterance = state.utteranceById[activeAudioUtterance.utteranceId]
		return {
			nextState: state,
			previousUtteranceId: utterance?.previousUtteranceId ?? null,
			utteranceId: activeAudioUtterance.utteranceId
		}
	}

	const utteranceId = `audio_utterance_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`
	const previousUtteranceId = previousSegment?.utteranceId ?? state.lastAudioUtteranceId ?? null
	const nextState = createAudioUtterance(state, {
		createdAt: input.now,
		inputOrigin: 'audio',
		previousUtteranceId,
		settings: input.settings,
		utteranceId
	})
	return {
		nextState: {
			...nextState,
			activeAudioUtteranceId: utteranceId,
			activeAudioUtteranceUpdatedAt: input.now,
			lastAudioUtteranceId: utteranceId
		},
		previousUtteranceId,
		utteranceId
	}
}

function updateAudioUtteranceActivity(
	state: TranslateRuntimeState,
	utteranceId: string,
	now: number
): TranslateRuntimeState {
	return {
		...state,
		activeAudioUtteranceId: utteranceId,
		activeAudioUtteranceUpdatedAt: now,
		lastAudioUtteranceId: utteranceId
	}
}

export function applySubtitleSegmentDelta(
	state: TranslateRuntimeState,
	input: AudioSegmentEvent & {
		now: number
		settings: TranslateSettings
	}
): TranslateRuntimeState {
	const normalizedText = normalizeWhitespace(input.text)
	if (!normalizedText) return state
	const resolvedUtterance = resolveAudioUtteranceForSegment(state, input)
	const utterance = resolvedUtterance.nextState.utteranceById[resolvedUtterance.utteranceId]
	if (!utterance) return state
	const nextSegmentState = {
		...resolvedUtterance.nextState,
		segmentById: {
			...resolvedUtterance.nextState.segmentById,
			[input.itemId]: {
				committedAt: resolvedUtterance.nextState.segmentById[input.itemId]?.committedAt ?? null,
				draftText: normalizedText,
				finalText: resolvedUtterance.nextState.segmentById[input.itemId]?.finalText ?? '',
				previousSegmentId: input.previousItemId ?? null,
				segmentId: input.itemId,
				utteranceId: resolvedUtterance.utteranceId
			}
		},
		utteranceById: {
			...resolvedUtterance.nextState.utteranceById,
			[resolvedUtterance.utteranceId]: {
				...utterance,
				orderedSegmentIds: insertSegmentId(
					utterance.orderedSegmentIds,
					input.itemId,
					input.previousItemId ?? null
				)
			}
		}
	}
	return refreshUtteranceSourceText(
		updateAudioUtteranceActivity(nextSegmentState, resolvedUtterance.utteranceId, input.now),
		resolvedUtterance.utteranceId
	)
}

export function applySubtitleSegmentFinal(
	state: TranslateRuntimeState,
	input: SubtitleFinalPatch & {
		settings: TranslateSettings
	}
): TranslateRuntimeState {
	const normalizedText = normalizeWhitespace(input.text)
	if (!normalizedText) return state
	const resolvedUtterance = resolveAudioUtteranceForSegment(state, {
		itemId: input.itemId,
		now: input.committedAt,
		previousItemId: input.previousItemId ?? null,
		settings: input.settings,
		text: normalizedText
	})
	const utterance = resolvedUtterance.nextState.utteranceById[resolvedUtterance.utteranceId]
	if (!utterance) return state
	const previousSegment = resolvedUtterance.nextState.segmentById[input.itemId]
	const nextSegmentState = {
		...resolvedUtterance.nextState,
		segmentById: {
			...resolvedUtterance.nextState.segmentById,
			[input.itemId]: {
				committedAt: input.committedAt,
				...(typeof input.confidence === 'number' ? { confidence: input.confidence } : {}),
				draftText: normalizedText,
				finalText: normalizedText,
				previousSegmentId: input.previousItemId ?? null,
				segmentId: input.itemId,
				utteranceId: previousSegment?.utteranceId ?? resolvedUtterance.utteranceId
			}
		},
		utteranceById: {
			...resolvedUtterance.nextState.utteranceById,
			[resolvedUtterance.utteranceId]: {
				...utterance,
				orderedSegmentIds: insertSegmentId(
					utterance.orderedSegmentIds,
					input.itemId,
					input.previousItemId ?? null
				)
			}
		}
	}
	return refreshUtteranceSourceText(
		updateAudioUtteranceActivity(nextSegmentState, resolvedUtterance.utteranceId, input.committedAt),
		resolvedUtterance.utteranceId
	)
}

export function upsertTypedTranslateUtterance(
	state: TranslateRuntimeState,
	input: {
		itemId: string
		now: number
		settings: TranslateSettings
		text: string
	}
): TranslateRuntimeState {
	const normalizedText = normalizeWhitespace(input.text)
	if (!normalizedText) return state
	const previousUtteranceId =
		state.orderedUtteranceIds.length > 0
			? (state.orderedUtteranceIds[state.orderedUtteranceIds.length - 1] ?? null)
			: null
	const nextState = createAudioUtterance(state, {
		createdAt: input.now,
		inputOrigin: 'text',
		previousUtteranceId,
		settings: input.settings,
		utteranceId: input.itemId
	})
	const utterance = nextState.utteranceById[input.itemId]
	if (!utterance) return nextState
	return {
		...nextState,
		utteranceById: {
			...nextState.utteranceById,
			[input.itemId]: {
				...utterance,
				phase: 'draft',
				sourceCommittedText: normalizedText,
				sourceLiveText: normalizedText
			}
		}
	}
}

export function applyTranslateDraftPatch(
	state: TranslateRuntimeState,
	patch: LiveTranslateDraftPatch,
	settings: TranslateSettings,
	now: number
): TranslateRuntimeState {
	const existingUtterance = state.utteranceById[patch.itemId]
	const baseState = existingUtterance
		? state
		: upsertTypedTranslateUtterance(state, {
				itemId: patch.itemId,
				now,
				settings,
				text: ''
			})
	const utterance = baseState.utteranceById[patch.itemId]
	if (!utterance || utterance.phase === 'final' || utterance.phase === 'error') return state
	if (patch.draftSequence < utterance.draftSequence) return state
	return {
		...baseState,
		utteranceById: {
			...baseState.utteranceById,
			[patch.itemId]: {
				...utterance,
				draftSequence: patch.draftSequence,
				draftTranslatedText: normalizeWhitespace(patch.translatedText),
				lastDraftAt: now,
				phase: 'draft',
				...(patch.responseId ? { responseId: patch.responseId } : {})
			}
		}
	}
}

export function applyTranslateResultPatch(
	state: TranslateRuntimeState,
	patch: LiveTranslateResultPatch,
	settings: TranslateSettings,
	now: number
): TranslateRuntimeState {
	const existingUtterance = state.utteranceById[patch.itemId]
	const baseState = existingUtterance
		? state
		: upsertTypedTranslateUtterance(state, {
				itemId: patch.itemId,
				now,
				settings,
				text: patch.sourceText
			})
	const utterance = baseState.utteranceById[patch.itemId]
	if (!utterance) return state
	const normalizedSourceText = normalizeWhitespace(patch.sourceText)
	const normalizedTranslatedText = normalizeWhitespace(patch.translatedText)
	return {
		...baseState,
		utteranceById: {
			...baseState.utteranceById,
			[patch.itemId]: {
				...utterance,
				direction: patch.direction,
				draftTranslatedText:
					patch.status === 'final' ? normalizedTranslatedText : utterance.draftTranslatedText,
				finalTranslatedText: patch.status === 'final' ? normalizedTranslatedText : '',
				phase: patch.status === 'final' ? 'final' : 'error',
				sourceCommittedText: normalizedSourceText || utterance.sourceCommittedText,
				sourceLanguageCode: patch.sourceLanguageCode,
				sourceLiveText: normalizedSourceText || utterance.sourceLiveText,
				targetLanguageCode: patch.targetLanguageCode,
				...(patch.status === 'error' ? { errorMessage: normalizedTranslatedText } : {}),
				...(patch.responseId ? { responseId: patch.responseId } : {})
			}
		}
	}
}

export function getTranslateCommittedSourceText(
	state: TranslateRuntimeState,
	utteranceId: string
): string {
	return state.utteranceById[utteranceId]?.sourceCommittedText ?? ''
}

export function applyCanonicalTranslateSourceText(
	state: TranslateRuntimeState,
	input: {
		sourceText: string
		utteranceId: string
	}
): TranslateRuntimeState {
	const utterance = state.utteranceById[input.utteranceId]
	if (!utterance) return state
	const normalizedSourceText = normalizeWhitespace(input.sourceText)
	if (!normalizedSourceText) return state
	return {
		...state,
		utteranceById: {
			...state.utteranceById,
			[input.utteranceId]: {
				...utterance,
				sourceCommittedText: normalizedSourceText,
				sourceLiveText: normalizedSourceText
			}
		}
	}
}

export function getTranslateLatestConfidence(
	state: TranslateRuntimeState,
	utteranceId: string
): number | undefined {
	const utterance = state.utteranceById[utteranceId]
	if (!utterance) return undefined
	const confidenceList = utterance.orderedSegmentIds
		.map(segmentId => state.segmentById[segmentId]?.confidence)
		.filter((value): value is number => typeof value === 'number')
	if (confidenceList.length === 0) return undefined
	return Math.min(...confidenceList)
}

export function clearTranslateUtterance(
	state: TranslateRuntimeState,
	utteranceId: string
): TranslateRuntimeState {
	const utterance = state.utteranceById[utteranceId]
	if (!utterance) return state
	const nextSegmentById = { ...state.segmentById }
	for (const segmentId of utterance.orderedSegmentIds) {
		delete nextSegmentById[segmentId]
	}
	const nextUtteranceById = { ...state.utteranceById }
	delete nextUtteranceById[utteranceId]
	return {
		...state,
		orderedUtteranceIds: state.orderedUtteranceIds.filter(id => id !== utteranceId),
		segmentById: nextSegmentById,
		utteranceById: nextUtteranceById
	}
}

export function selectTranslateCards(state: TranslateRuntimeState): UtteranceCard[] {
	return state.orderedUtteranceIds
		.map(utteranceId => state.utteranceById[utteranceId])
		.filter((utterance): utterance is TranslateUtteranceState => !!utterance)
		.map(utterance => {
			const translatedText =
				utterance.finalTranslatedText || utterance.draftTranslatedText || utterance.errorMessage || ''
			const status =
				utterance.phase === 'final'
					? 'final'
					: utterance.phase === 'error'
						? 'error'
						: utterance.phase === 'draft'
							? 'draft'
							: 'streaming'
			return {
				createdAt: utterance.createdAt,
				direction: utterance.direction,
				draftSequence: utterance.draftSequence,
				...(utterance.draftTranslatedText
					? { draftTranslatedText: utterance.draftTranslatedText }
					: {}),
				...(utterance.errorMessage ? { errorMessage: utterance.errorMessage } : {}),
				id: utterance.utteranceId,
				inputOrigin: utterance.inputOrigin,
				...(utterance.lastDraftAt ? { lastDraftAt: utterance.lastDraftAt } : {}),
				renderState: utterance.phase,
				...(utterance.responseId ? { responseId: utterance.responseId } : {}),
				sourceItemId: utterance.utteranceId,
				sourceLanguageCode: utterance.sourceLanguageCode,
				sourceText: utterance.sourceCommittedText || utterance.sourceLiveText,
				status,
				targetLanguageCode: utterance.targetLanguageCode,
				translatedText,
				utteranceSequence: utterance.utteranceSequence
			} satisfies UtteranceCard
		})
}

export function selectLiveSubtitleState(
	state: TranslateRuntimeState,
	isListening: boolean,
	updatedAt: number
): LiveSubtitleState {
	const activeUtterance = state.activeAudioUtteranceId
		? state.utteranceById[state.activeAudioUtteranceId]
		: null
	return {
		activeSegmentId: activeUtterance?.utteranceId ?? null,
		isListening,
		text: '',
		updatedAt
	}
}
