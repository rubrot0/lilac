import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { z } from 'zod'

type SmokeAudioPrompt = {
	expectedTranscript: string
	fileName: string
	languageCode: 'en' | 'es' | 'uk'
	text: string
}

const smokeAudioPromptList: SmokeAudioPrompt[] = [
	{
		expectedTranscript:
			'Hello everyone. This is a Lilac translation smoke test. We are validating live production conversation flow.',
		fileName: 'en_smoke',
		languageCode: 'en',
		text:
			'Hello everyone. This is a Lilac translation smoke test. We are validating live production conversation flow.'
	},
	{
		expectedTranscript:
			'Hola a todos. Esta es una prueba de humo de traduccion de Lilac. Estamos validando el flujo de conversacion en produccion.',
		fileName: 'es_smoke',
		languageCode: 'es',
		text:
			'Hola a todos. Esta es una prueba de humo de traduccion de Lilac. Estamos validando el flujo de conversacion en produccion.'
	},
	{
		expectedTranscript: 'Hello Lilac. Can you help me practice Ukrainian today?',
		fileName: 'chat_question_en',
		languageCode: 'en',
		text: 'Hello Lilac. Can you help me practice Ukrainian today?'
	},
	{
		expectedTranscript: 'Hello. I was wondering if you saw the news.',
		fileName: 'translate_en_simple',
		languageCode: 'en',
		text: 'Hello. I was wondering if you saw the news.'
	},
	{
		expectedTranscript: 'Hola. Me preguntaba si viste las noticias.',
		fileName: 'translate_es_simple',
		languageCode: 'es',
		text: 'Hola. Me preguntaba si viste las noticias.'
	},
	{
		expectedTranscript: 'Um hello. So the other day, um, I was wondering, um, did you see the news?',
		fileName: 'translate_en_fillers',
		languageCode: 'en',
		text: 'Um hello. So the other day, um, I was wondering, um, did you see the news?'
	},
	{
		expectedTranscript: 'Привіт. Мені було цікаво, чи бачив ти новини.',
		fileName: 'translate_uk_simple',
		languageCode: 'uk',
		text: 'Привіт. Мені було цікаво, чи бачив ти новини.'
	},
	{
		expectedTranscript:
			'Hello there. This is a longer Lilac translation evaluation. I am speaking continuously so the subtitle system can be measured for live updates, chunk replacement, and final translation quality over a longer turn.',
		fileName: 'translate_en_long',
		languageCode: 'en',
		text:
			'Hello there. This is a longer Lilac translation evaluation. I am speaking continuously so the subtitle system can be measured for live updates, chunk replacement, and final translation quality over a longer turn.'
	}
]

const fixturesDirectoryPath = resolve(process.cwd(), '.artifacts/smoke/fixtures')
const fixtureManifestPath = join(fixturesDirectoryPath, 'fixtures.manifest.json')

const FixtureManifestSchema = z.object({
	fixtureList: z.array(
		z.object({
			expectedTranscript: z.string().min(1),
			fileName: z.string().min(1),
			languageCode: z.enum(['en', 'es', 'uk']),
			wavPath: z.string().min(1)
		})
	)
})

function requireOpenAiApiKey(): string {
	const openAiApiKey = process.env.OPENAI_API_KEY?.trim()
	if (!openAiApiKey) {
		throw new Error('OPENAI_API_KEY is required for smoke audio generation.')
	}
	return openAiApiKey
}

function buildNoisyFixture(fileName: string): void {
	const sourceWavPath = join(fixturesDirectoryPath, `${fileName}.fixture.wav`)
	const noisyOutputPath = join(fixturesDirectoryPath, `${fileName}_noisy.fixture.wav`)
	runFfmpeg([
		'-y',
		'-i',
		sourceWavPath,
		'-f',
		'lavfi',
		'-i',
		'anoisesrc=color=white:amplitude=0.02',
		'-filter_complex',
		'[0:a][1:a]amix=inputs=2:weights=1 0.18:duration=first:dropout_transition=0',
		'-ar',
		'48000',
		'-ac',
		'1',
		'-sample_fmt',
		's16',
		noisyOutputPath
	])
}

function runFfmpeg(argumentList: string[]): void {
	const ffmpegResult = spawnSync('ffmpeg', argumentList, { encoding: 'utf8' })
	if (ffmpegResult.status !== 0) {
		throw new Error(`ffmpeg failed: ${ffmpegResult.stderr || ffmpegResult.stdout}`)
	}
}

async function generatePromptAudio(prompt: SmokeAudioPrompt, openAiApiKey: string): Promise<void> {
	const mp3OutputPath = join(fixturesDirectoryPath, `${prompt.fileName}.mp3`)
	const wavOutputPath = join(fixturesDirectoryPath, `${prompt.fileName}.wav`)
	const paddedOutputPath = join(fixturesDirectoryPath, `${prompt.fileName}.fixture.wav`)

	const ttsResponse = await fetch('https://api.openai.com/v1/audio/speech', {
		body: JSON.stringify({
			input: prompt.text,
			model: 'gpt-4o-mini-tts',
			voice: 'alloy'
		}),
		headers: {
			Authorization: `Bearer ${openAiApiKey}`,
			'Content-Type': 'application/json'
		},
		method: 'POST'
	})

	if (!ttsResponse.ok) {
		const errorText = await ttsResponse.text()
		throw new Error(`TTS generation failed for ${prompt.fileName}: ${errorText}`)
	}

	const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer())
	await writeFile(mp3OutputPath, audioBuffer)

	runFfmpeg([
		'-y',
		'-i',
		mp3OutputPath,
		'-ar',
		'48000',
		'-ac',
		'1',
		'-sample_fmt',
		's16',
		wavOutputPath
	])

	runFfmpeg([
		'-y',
		'-f',
		'lavfi',
		'-i',
		'anullsrc=r=48000:cl=mono:d=1.5',
		'-i',
		wavOutputPath,
		'-f',
		'lavfi',
		'-i',
		'anullsrc=r=48000:cl=mono:d=1.5',
		'-filter_complex',
		'[0:a][1:a][2:a]concat=n=3:v=0:a=1',
		'-ar',
		'48000',
		'-ac',
		'1',
		'-sample_fmt',
		's16',
		paddedOutputPath
	])
}

function buildConversationFixture(): void {
	const conversationOutputPath = join(fixturesDirectoryPath, 'conversation_smoke.wav')
	const englishWavPath = join(fixturesDirectoryPath, 'en_smoke.wav')
	const spanishWavPath = join(fixturesDirectoryPath, 'es_smoke.wav')

	runFfmpeg([
		'-y',
		'-f',
		'lavfi',
		'-i',
		'anullsrc=r=48000:cl=mono:d=4',
		'-i',
		englishWavPath,
		'-f',
		'lavfi',
		'-i',
		'anullsrc=r=48000:cl=mono:d=3',
		'-i',
		spanishWavPath,
		'-f',
		'lavfi',
		'-i',
		'anullsrc=r=48000:cl=mono:d=3',
		'-i',
		englishWavPath,
		'-f',
		'lavfi',
		'-i',
		'anullsrc=r=48000:cl=mono:d=3',
		'-i',
		spanishWavPath,
		'-filter_complex',
		'[0:a][1:a][2:a][3:a][4:a][5:a][6:a]concat=n=7:v=0:a=1',
		'-ar',
		'48000',
		'-ac',
		'1',
		'-sample_fmt',
		's16',
		conversationOutputPath
	])
}

function buildSilentFixture(): void {
	const silentOutputPath = join(fixturesDirectoryPath, 'silence_5s.wav')
	runFfmpeg([
		'-y',
		'-f',
		'lavfi',
		'-i',
		'anullsrc=r=48000:cl=mono:d=5',
		'-ar',
		'48000',
		'-ac',
		'1',
		'-sample_fmt',
		's16',
		silentOutputPath
	])
}

async function writeFixtureManifest(): Promise<void> {
	const manifest = FixtureManifestSchema.parse({
		fixtureList: smokeAudioPromptList.map(prompt => ({
			expectedTranscript: prompt.expectedTranscript,
			fileName: prompt.fileName,
			languageCode: prompt.languageCode,
			wavPath: join(fixturesDirectoryPath, `${prompt.fileName}.fixture.wav`)
		}))
	})
	await writeFile(fixtureManifestPath, JSON.stringify(manifest, null, 2), 'utf8')
}

async function main(): Promise<void> {
	const openAiApiKey = requireOpenAiApiKey()
	await mkdir(fixturesDirectoryPath, { recursive: true })

	for (const prompt of smokeAudioPromptList) {
		await generatePromptAudio(prompt, openAiApiKey)
	}

	buildNoisyFixture('translate_en_fillers')
	buildConversationFixture()
	buildSilentFixture()
	await writeFixtureManifest()

	console.log(`Smoke fixtures generated in ${fixturesDirectoryPath}`)
}

void main().catch(error => {
	console.error(error instanceof Error ? error.message : 'Smoke audio generation failed.')
	process.exit(1)
})
