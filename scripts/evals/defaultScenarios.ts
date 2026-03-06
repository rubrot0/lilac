import { resolve } from 'node:path'

import { type EvalScenarioSpec, EvalScenarioSpecSchema } from '@/evals/contracts'

const fixturesDirectoryPath = resolve(process.cwd(), '.artifacts/smoke/fixtures')

const scenarioList = [
	{
		expectedAssistantMeaning:
			'The assistant should acknowledge the user and offer help practicing Ukrainian.',
		expectedUiStates: ['chat_transcript_visible', 'assistant_response_visible'],
		id: 'chat_typed_practice_ukrainian',
		inputType: 'text',
		languageExpectation: {},
		latencyBands: {
			assistantTextFirstMs: 20_000
		},
		mode: 'chat',
		typedText: 'Hello. Can you help me practice Ukrainian today?'
	},
	{
		audioFixturePath: resolve(fixturesDirectoryPath, 'chat_question_en.fixture.wav'),
		expectedAssistantMeaning:
			'The assistant should respond helpfully to a request for Ukrainian practice.',
		expectedUiStates: [
			'chat_transcript_visible',
			'assistant_response_visible',
			'assistant_audio_started'
		],
		expectedUserTranscript: 'Hello Lilac. Can you help me practice Ukrainian today?',
		id: 'chat_audio_practice_ukrainian',
		inputType: 'audio',
		languageExpectation: {
			inputLanguageCode: 'en',
			outputLanguageCode: 'en'
		},
		latencyBands: {
			assistantAudioStartMs: 20_000,
			assistantTextFirstMs: 20_000
		},
		mode: 'chat'
	},
	{
		expectedTranslationMeaning:
			'The translation should preserve the meaning of asking whether someone saw the news.',
		expectedUiStates: [
			'translate_card_visible',
			'draft_translation_visible',
			'final_translation_visible'
		],
		expectedUserTranscript: 'Hello. I was wondering if you saw the news.',
		id: 'translate_typed_en_to_es',
		inputType: 'text',
		languageExpectation: {
			pair: {
				from: 'en',
				to: 'es'
			}
		},
		latencyBands: {
			finalOutputMs: 12_000,
			firstVisibleDraftMs: 6_000
		},
		mode: 'translate',
		typedText: 'Hello. I was wondering if you saw the news.'
	},
	{
		audioFixturePath: resolve(fixturesDirectoryPath, 'translate_en_simple.fixture.wav'),
		expectedTranslationMeaning:
			'The translation should preserve the meaning of asking whether someone saw the news.',
		expectedUiStates: [
			'translate_card_visible',
			'draft_translation_visible',
			'final_translation_visible'
		],
		expectedUserTranscript: 'Hello. I was wondering if you saw the news.',
		id: 'translate_audio_en_to_es',
		inputType: 'audio',
		languageExpectation: {
			pair: {
				from: 'en',
				to: 'es'
			}
		},
		latencyBands: {
			finalOutputMs: 15_000,
			firstVisibleDraftMs: 7_000,
			firstVisibleSourceMs: 4_000
		},
		mode: 'translate'
	},
	{
		audioFixturePath: resolve(fixturesDirectoryPath, 'translate_uk_simple.fixture.wav'),
		expectedTranslationMeaning:
			'The translation should preserve the meaning of asking whether someone saw the news.',
		expectedUiStates: [
			'translate_card_visible',
			'draft_translation_visible',
			'final_translation_visible'
		],
		expectedUserTranscript: 'Привіт. Мені було цікаво, чи бачив ти новини.',
		id: 'translate_audio_uk_to_en',
		inputType: 'audio',
		languageExpectation: {
			pair: {
				from: 'uk',
				to: 'en'
			}
		},
		latencyBands: {
			finalOutputMs: 15_000,
			firstVisibleDraftMs: 7_000,
			firstVisibleSourceMs: 4_000
		},
		mode: 'translate'
	},
	{
		audioFixturePath: resolve(fixturesDirectoryPath, 'translate_es_simple.fixture.wav'),
		expectedTranslationMeaning:
			'The translation should preserve the meaning of asking whether someone saw the news.',
		expectedUiStates: [
			'translate_card_visible',
			'draft_translation_visible',
			'final_translation_visible'
		],
		expectedUserTranscript: 'Hola. Me preguntaba si viste las noticias.',
		id: 'translate_audio_es_to_en',
		inputType: 'audio',
		languageExpectation: {
			pair: {
				from: 'es',
				to: 'en'
			}
		},
		latencyBands: {
			finalOutputMs: 15_000,
			firstVisibleDraftMs: 7_000,
			firstVisibleSourceMs: 4_000
		},
		mode: 'translate'
	},
	{
		audioFixturePath: resolve(fixturesDirectoryPath, 'translate_en_long.fixture.wav'),
		expectedTranslationMeaning:
			'The translation should preserve a longer explanation about live evaluation, chunk replacement, and translation quality.',
		expectedUiStates: [
			'translate_card_visible',
			'draft_translation_visible',
			'final_translation_visible'
		],
		expectedUserTranscript:
			'Hello there. This is a longer Lilac translation evaluation. I am speaking continuously so the subtitle system can be measured for live updates, chunk replacement, and final translation quality over a longer turn.',
		id: 'translate_audio_en_long_to_es',
		inputType: 'audio',
		languageExpectation: {
			pair: {
				from: 'en',
				to: 'es'
			}
		},
		latencyBands: {
			finalOutputMs: 18_000,
			firstVisibleDraftMs: 8_000,
			firstVisibleSourceMs: 4_000
		},
		mode: 'translate'
	},
	{
		audioFixturePath: resolve(fixturesDirectoryPath, 'translate_en_fillers_noisy.fixture.wav'),
		expectedTranslationMeaning:
			'The translation should preserve the meaning of greeting someone and asking whether they saw the news despite filler words and mild background noise.',
		expectedUiStates: [
			'translate_card_visible',
			'draft_translation_visible',
			'final_translation_visible'
		],
		expectedUserTranscript:
			'Um hello. So the other day, um, I was wondering, um, did you see the news?',
		id: 'translate_audio_en_noisy_fillers_to_es',
		inputType: 'audio',
		languageExpectation: {
			pair: {
				from: 'en',
				to: 'es'
			}
		},
		latencyBands: {
			finalOutputMs: 16_000,
			firstVisibleDraftMs: 8_000,
			firstVisibleSourceMs: 4_500
		},
		mode: 'translate'
	}
] satisfies EvalScenarioSpec[]

export const defaultEvalScenarioList = scenarioList.map(scenario =>
	EvalScenarioSpecSchema.parse(scenario)
)

export function resolveEvalScenarioList(scenarioIdList?: string[]): EvalScenarioSpec[] {
	if (!scenarioIdList || scenarioIdList.length === 0) return defaultEvalScenarioList
	const wantedScenarioIdSet = new Set(scenarioIdList)
	return defaultEvalScenarioList.filter(scenario => wantedScenarioIdSet.has(scenario.id))
}
