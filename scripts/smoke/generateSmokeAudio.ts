import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

type SmokeAudioPrompt = {
	fileName: string
	languageCode: 'en' | 'es'
	text: string
}

const smokeAudioPrompts: SmokeAudioPrompt[] = [
	{
		fileName: 'en_smoke',
		languageCode: 'en',
		text:
			'Hello everyone. This is a Lilac translation smoke test. We are validating live production conversation flow.'
	},
	{
		fileName: 'es_smoke',
		languageCode: 'es',
		text:
			'Hola a todos. Esta es una prueba de humo de traduccion de Lilac. Estamos validando el flujo de conversacion en produccion.'
	}
]

const fixturesDirectoryPath = resolve(process.cwd(), '.artifacts/smoke/fixtures')

function requireOpenAiApiKey(): string {
	const openAiApiKey = process.env.OPENAI_API_KEY?.trim()
	if (!openAiApiKey) {
		throw new Error('OPENAI_API_KEY is required for smoke audio generation.')
	}
	return openAiApiKey
}

function runFfmpeg(args: string[]): void {
	const ffmpegResult = spawnSync('ffmpeg', args, { encoding: 'utf8' })
	if (ffmpegResult.status !== 0) {
		throw new Error(`ffmpeg failed: ${ffmpegResult.stderr || ffmpegResult.stdout}`)
	}
}

async function generatePromptAudio(prompt: SmokeAudioPrompt, openAiApiKey: string): Promise<void> {
	const mp3OutputPath = join(fixturesDirectoryPath, `${prompt.fileName}.mp3`)
	const wavOutputPath = join(fixturesDirectoryPath, `${prompt.fileName}.wav`)

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

async function main(): Promise<void> {
	const openAiApiKey = requireOpenAiApiKey()
	await mkdir(fixturesDirectoryPath, { recursive: true })

	for (const prompt of smokeAudioPrompts) {
		await generatePromptAudio(prompt, openAiApiKey)
	}

	buildConversationFixture()

	console.log(`Smoke fixtures generated in ${fixturesDirectoryPath}`)
}

void main().catch(error => {
	console.error(error instanceof Error ? error.message : 'Smoke audio generation failed.')
	process.exit(1)
})
