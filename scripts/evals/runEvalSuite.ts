import { spawnSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
	type Browser,
	type BrowserContext,
	type ConsoleMessage,
	chromium,
	type Page
} from 'playwright'
import { z } from 'zod'

import {
	type EvalCandidateConfig,
	EvalMatrixSchema,
	type EvalRunSummary,
	EvalRunSummarySchema,
	EvalScenarioRunSummarySchema,
	type EvalScenarioSpec,
	LilacTestBusEventSchema
} from '@/evals/contracts'
import {
	collectRuntimeErrorMatches,
	type RuntimeLogCapture,
	startVercelRuntimeLogCapture
} from '../smoke/captureVercelRuntimeLogs'
import { resolveEvalScenarioList } from './defaultScenarios'
import {
	buildScenarioScorecard,
	runAudioInputReferenceJudge,
	runAudioOutputListenerJudge,
	runHardGuardrailJudge,
	runSemanticConversationJudge,
	runVisualUiJudge
} from './judges'
import type { ScenarioObservation } from './runtimeTypes'

type EvalRunOptions = {
	candidateConfig: EvalCandidateConfig
	captureVercelLogs: boolean
	evaluationId?: string
	scenarioIdList?: string[]
	targetUrl: string
}

type ParsedArgumentList = {
	candidateId: string
	captureVercelLogs: boolean
	evaluationId?: string
	matrixPath: string
	scenarioIdList?: string[]
	targetUrl: string
}

type ScenarioArtifactCollectors = {
	consoleEntryList: string[]
	stop: () => Promise<void>
}

export type EvalRunExecution = {
	observationList: ScenarioObservation[]
	runSummary: EvalRunSummary
}

type ParsedLilacTestBusEvent = z.infer<typeof LilacTestBusEventSchema>
type AssistantAudioStateEvent = Extract<
	ParsedLilacTestBusEvent,
	{ eventType: 'assistant_audio_state_changed' }
>
type ChatTranscriptEvent = Extract<ParsedLilacTestBusEvent, { eventType: 'chat_transcript_patch' }>
type SubtitleStateEvent = Extract<ParsedLilacTestBusEvent, { eventType: 'subtitle_state_changed' }>
type TranslateCardEvent = Extract<ParsedLilacTestBusEvent, { eventType: 'translate_card_patch' }>
type VisibleErrorEvent = Extract<ParsedLilacTestBusEvent, { eventType: 'visible_error_changed' }>

const defaultSilentAudioFixturePath = resolve(
	process.cwd(),
	'.artifacts/smoke/fixtures/silence_5s.wav'
)
const defaultFixtureManifestPath = resolve(
	process.cwd(),
	'.artifacts/smoke/fixtures/fixtures.manifest.json'
)
const defaultViewport = {
	height: 900,
	width: 1365
}
const mobileViewportList = [
	{ height: 812, width: 375 },
	{ height: 844, width: 390 }
] as const

function parseArguments(argumentList: string[]): ParsedArgumentList {
	const parsedArguments: ParsedArgumentList = {
		candidateId: 'workspace-preview',
		captureVercelLogs: true,
		matrixPath: resolve(process.cwd(), 'scripts/evals/manifests/default.matrix.json'),
		targetUrl: 'https://lilac.chat'
	}

	for (let argumentIndex = 0; argumentIndex < argumentList.length; argumentIndex += 1) {
		const argument = argumentList[argumentIndex]
		switch (argument) {
			case '--candidate-id': {
				parsedArguments.candidateId = argumentList[argumentIndex + 1] ?? parsedArguments.candidateId
				argumentIndex += 1
				break
			}
			case '--evaluation-id': {
				const evaluationId = argumentList[argumentIndex + 1]
				if (evaluationId) {
					parsedArguments.evaluationId = evaluationId
				}
				argumentIndex += 1
				break
			}
			case '--matrix-path': {
				parsedArguments.matrixPath = resolve(
					argumentList[argumentIndex + 1] ?? parsedArguments.matrixPath
				)
				argumentIndex += 1
				break
			}
			case '--scenario-ids': {
				const rawScenarioIdList = argumentList[argumentIndex + 1] ?? ''
				parsedArguments.scenarioIdList = rawScenarioIdList
					.split(',')
					.map(value => value.trim())
					.filter(Boolean)
				argumentIndex += 1
				break
			}
			case '--skip-vercel-logs': {
				parsedArguments.captureVercelLogs = false
				break
			}
			case '--target-url': {
				parsedArguments.targetUrl = argumentList[argumentIndex + 1] ?? parsedArguments.targetUrl
				argumentIndex += 1
				break
			}
			default:
				break
		}
	}

	return parsedArguments
}

function createTimestampLabel(): string {
	return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

function createEvaluationId(): string {
	return `eval-${createTimestampLabel()}`
}

function getGitCommitSha(): string {
	const result = spawnSync('git', ['rev-parse', 'HEAD'], {
		cwd: process.cwd(),
		encoding: 'utf8'
	})
	return result.status === 0 ? result.stdout.trim() : 'unknown'
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

async function ensureAudioFixturesReady(scenarioList: EvalScenarioSpec[]): Promise<void> {
	const requiredPathList = [
		defaultSilentAudioFixturePath,
		defaultFixtureManifestPath,
		...scenarioList
			.map(scenario => scenario.audioFixturePath)
			.filter((value): value is string => typeof value === 'string' && value.length > 0)
	]
	const missingPathList: string[] = []
	for (const requiredPath of requiredPathList) {
		if (!(await pathExists(requiredPath))) {
			missingPathList.push(requiredPath)
		}
	}
	if (missingPathList.length === 0) return

	const generationResult = spawnSync('bun', ['run', 'smoke:prepare-audio'], {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: process.env,
		stdio: 'inherit'
	})
	if (generationResult.status !== 0) {
		throw new Error('Audio fixture generation failed while preparing eval scenarios.')
	}

	const unresolvedPathList: string[] = []
	for (const requiredPath of requiredPathList) {
		if (!(await pathExists(requiredPath))) {
			unresolvedPathList.push(requiredPath)
		}
	}
	if (unresolvedPathList.length > 0) {
		throw new Error(`Missing required eval audio fixtures: ${unresolvedPathList.join(', ')}`)
	}
}

async function waitForCondition(
	condition: () => Promise<boolean>,
	timeoutMilliseconds: number,
	errorMessage: string
): Promise<void> {
	const startTime = Date.now()
	while (Date.now() - startTime <= timeoutMilliseconds) {
		const passed = await condition()
		if (passed) return
		await new Promise(resolveTimeout => setTimeout(resolveTimeout, 350))
	}
	throw new Error(errorMessage)
}

async function switchToModeWithRetry(
	page: Page,
	targetMode: 'chat' | 'translate',
	maxAttempts = 3
): Promise<void> {
	const triggerTestId = targetMode === 'chat' ? 'mode-tab-chat' : 'mode-tab-translate'
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		await page.keyboard.press('Escape').catch(() => {})
		await page.getByTestId(triggerTestId).click({ timeout: 15_000 })
		try {
			await waitForCondition(
				async function hasTargetModeTabState(): Promise<boolean> {
					const stateAttributeValue = await page.getByTestId(triggerTestId).getAttribute('data-state')
					return stateAttributeValue === 'active'
				},
				8_000,
				`Mode switch to ${targetMode} did not complete.`
			)
			return
		} catch {
			if (attempt === maxAttempts) {
				throw new Error(`Mode switch to ${targetMode} did not complete.`)
			}
		}
	}
}

async function ensureVoiceInputEnabled(page: Page): Promise<void> {
	const voiceToggle = page.getByTestId('header-voice-input-toggle')
	await voiceToggle.waitFor({ state: 'visible', timeout: 10_000 })
	const ariaLabel = (await voiceToggle.getAttribute('aria-label')) ?? ''
	if (ariaLabel.toLowerCase().includes('enable microphone')) {
		await voiceToggle.click()
		await page.waitForTimeout(500)
	}
}

async function openTranslateLanguagePicker(page: Page): Promise<void> {
	const desktopButton = page.getByTestId('translate-language-picker-open-desktop')
	if (await desktopButton.isVisible().catch(() => false)) {
		await desktopButton.click()
		return
	}
	await page.getByTestId('translate-language-picker-open-mobile').click()
}

async function setTranslateLanguagePair(
	page: Page,
	languagePair: { from: string; to: string }
): Promise<void> {
	await openTranslateLanguagePicker(page)

	const primarySearchInput = page.getByTestId('translate-primary-language-search')
	await primarySearchInput.fill(languagePair.from)
	await page
		.getByTestId(`translate-primary-language-option-${languagePair.from.toLowerCase()}`)
		.click()

	const secondarySearchInput = page.getByTestId('translate-secondary-language-search')
	await secondarySearchInput.fill(languagePair.to)
	await page
		.getByTestId(`translate-secondary-language-option-${languagePair.to.toLowerCase()}`)
		.click()
	await page.keyboard.press('Escape').catch(() => {})
}

async function installEvalCaptureHooks(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const globalWindow = window as typeof window & {
			__lilacTestBus?: {
				assistantAudioElement: HTMLAudioElement | null
				eventLog: unknown[]
			}
			__lilacEvalCapture?: {
				startAssistantAudioRecorder: () => Promise<boolean>
				stopAssistantAudioRecorder: () => Promise<null | { base64: string; mimeType: string }>
			}
		}
		globalWindow.__lilacEvalCapture = {
			async startAssistantAudioRecorder(): Promise<boolean> {
				const lilacTestBus = globalWindow.__lilacTestBus
				const audioElement = lilacTestBus?.assistantAudioElement
				if (!(audioElement instanceof HTMLAudioElement)) return false
				const audioStream = audioElement.srcObject
				if (!(audioStream instanceof MediaStream)) return false
				const audioTrackList = audioStream.getAudioTracks()
				if (audioTrackList.length === 0) return false
				const captureWindow = globalWindow as typeof globalWindow & {
					__lilacEvalActiveRecorder?: MediaRecorder | null
					__lilacEvalAudioChunkList?: Blob[]
					__lilacEvalRecorderMimeType?: string
				}
				if (captureWindow.__lilacEvalActiveRecorder) return true
				const preferredMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
					? 'audio/webm;codecs=opus'
					: 'audio/webm'
				captureWindow.__lilacEvalAudioChunkList = []
				captureWindow.__lilacEvalRecorderMimeType = preferredMimeType
				const mediaRecorder = new MediaRecorder(audioStream, { mimeType: preferredMimeType })
				mediaRecorder.addEventListener('dataavailable', event => {
					if (!event.data || event.data.size === 0) return
					captureWindow.__lilacEvalAudioChunkList?.push(event.data)
				})
				mediaRecorder.start(250)
				captureWindow.__lilacEvalActiveRecorder = mediaRecorder
				return true
			},
			async stopAssistantAudioRecorder(): Promise<null | { base64: string; mimeType: string }> {
				const captureWindow = globalWindow as typeof globalWindow & {
					__lilacEvalActiveRecorder?: MediaRecorder | null
					__lilacEvalAudioChunkList?: Blob[]
					__lilacEvalRecorderMimeType?: string
				}
				const mediaRecorder = captureWindow.__lilacEvalActiveRecorder
				if (!mediaRecorder) return null
				const blob = await new Promise<Blob>(resolve => {
					mediaRecorder.addEventListener(
						'stop',
						() => {
							resolve(
								new Blob(captureWindow.__lilacEvalAudioChunkList ?? [], {
									type: captureWindow.__lilacEvalRecorderMimeType ?? 'audio/webm'
								})
							)
						},
						{ once: true }
					)
					mediaRecorder.stop()
				})
				captureWindow.__lilacEvalActiveRecorder = null
				captureWindow.__lilacEvalAudioChunkList = []
				const arrayBuffer = await blob.arrayBuffer()
				const byteArray = new Uint8Array(arrayBuffer)
				let binaryString = ''
				for (let byteIndex = 0; byteIndex < byteArray.length; byteIndex += 1) {
					binaryString += String.fromCharCode(byteArray[byteIndex] ?? 0)
				}
				return {
					base64: btoa(binaryString),
					mimeType: blob.type || captureWindow.__lilacEvalRecorderMimeType || 'audio/webm'
				}
			}
		}
	})
}

function convertConsoleMessageToString(consoleMessage: ConsoleMessage): string {
	return `[${consoleMessage.type()}] ${consoleMessage.text()}`
}

async function startScenarioArtifactCollectors(
	page: Page,
	scenarioArtifactDirectoryPath: string
): Promise<ScenarioArtifactCollectors> {
	const screenshotDirectoryPath = join(scenarioArtifactDirectoryPath, 'screenshots')
	const domSnapshotDirectoryPath = join(scenarioArtifactDirectoryPath, 'dom-snapshots')
	await mkdir(screenshotDirectoryPath, { recursive: true })
	await mkdir(domSnapshotDirectoryPath, { recursive: true })

	const consoleEntryList: string[] = []
	const handleConsoleMessage = (consoleMessage: ConsoleMessage): void => {
		consoleEntryList.push(convertConsoleMessageToString(consoleMessage))
	}
	const handlePageError = (error: Error): void => {
		consoleEntryList.push(`[pageerror] ${error.message}`)
	}
	page.on('console', handleConsoleMessage)
	page.on('pageerror', handlePageError)

	let screenshotSequence = 0
	let isStopped = false
	let previousEventCount = -1
	const intervalId = setInterval(async () => {
		if (isStopped) return
		try {
			const eventCount = await page.evaluate(() => window.__lilacTestBus?.eventLog.length ?? 0)
			if (eventCount === previousEventCount && screenshotSequence > 0) return
			previousEventCount = eventCount
			screenshotSequence += 1
			const screenshotPath = join(
				screenshotDirectoryPath,
				`${String(screenshotSequence).padStart(3, '0')}-events-${eventCount}.png`
			)
			const htmlPath = join(
				domSnapshotDirectoryPath,
				`${String(screenshotSequence).padStart(3, '0')}-events-${eventCount}.html`
			)
			await page.screenshot({ fullPage: true, path: screenshotPath })
			await writeFile(htmlPath, await page.content(), 'utf8')
		} catch (error) {
			consoleEntryList.push(
				`[collector] ${error instanceof Error ? error.message : 'collector capture failed'}`
			)
		}
	}, 1200)

	return {
		consoleEntryList,
		async stop(): Promise<void> {
			isStopped = true
			clearInterval(intervalId)
			page.off('console', handleConsoleMessage)
			page.off('pageerror', handlePageError)
		}
	}
}

async function getTestBusEventList(page: Page) {
	const rawEventList = await page.evaluate(() => window.__lilacTestBus?.eventLog ?? [])
	return z.array(LilacTestBusEventSchema).parse(rawEventList)
}

function isAssistantAudioStateEvent(
	event: ParsedLilacTestBusEvent
): event is AssistantAudioStateEvent {
	return event.eventType === 'assistant_audio_state_changed'
}

function isChatTranscriptEvent(event: ParsedLilacTestBusEvent): event is ChatTranscriptEvent {
	return event.eventType === 'chat_transcript_patch'
}

function isSubtitleStateEvent(event: ParsedLilacTestBusEvent): event is SubtitleStateEvent {
	return event.eventType === 'subtitle_state_changed'
}

function isTranslateCardEvent(event: ParsedLilacTestBusEvent): event is TranslateCardEvent {
	return event.eventType === 'translate_card_patch'
}

function isVisibleErrorEvent(event: ParsedLilacTestBusEvent): event is VisibleErrorEvent {
	return event.eventType === 'visible_error_changed'
}

async function maybeStartAssistantAudioRecorder(page: Page): Promise<boolean> {
	return page.evaluate(async () => {
		const globalWindow = window as typeof window & {
			__lilacEvalCapture?: {
				startAssistantAudioRecorder: () => Promise<boolean>
			}
		}
		return (await globalWindow.__lilacEvalCapture?.startAssistantAudioRecorder()) ?? false
	})
}

async function stopAssistantAudioRecorder(
	page: Page,
	audioArtifactDirectoryPath: string,
	scenarioId: string
): Promise<null | string> {
	const recordingResult = await page.evaluate(async () => {
		const globalWindow = window as typeof window & {
			__lilacEvalCapture?: {
				stopAssistantAudioRecorder: () => Promise<null | { base64: string; mimeType: string }>
			}
		}
		return (await globalWindow.__lilacEvalCapture?.stopAssistantAudioRecorder()) ?? null
	})
	if (!recordingResult) return null
	await mkdir(audioArtifactDirectoryPath, { recursive: true })
	const webmArtifactPath = join(audioArtifactDirectoryPath, `${scenarioId}.webm`)
	const wavArtifactPath = join(audioArtifactDirectoryPath, `${scenarioId}.wav`)
	await writeFile(webmArtifactPath, Buffer.from(recordingResult.base64, 'base64'))
	const ffmpegResult = spawnSync(
		'ffmpeg',
		['-y', '-i', webmArtifactPath, '-ar', '24000', '-ac', '1', wavArtifactPath],
		{ encoding: 'utf8' }
	)
	if (ffmpegResult.status !== 0) {
		return webmArtifactPath
	}
	return wavArtifactPath
}

async function configureScenario(page: Page, scenario: EvalScenarioSpec): Promise<void> {
	await switchToModeWithRetry(page, scenario.mode)
	await ensureVoiceInputEnabled(page)
	if (scenario.mode !== 'translate') return
	const languagePair = scenario.languageExpectation.pair
	if (!languagePair) return
	await setTranslateLanguagePair(page, languagePair)
}

async function submitScenarioInput(page: Page, scenario: EvalScenarioSpec): Promise<number> {
	const startedAt = Date.now()
	switch (scenario.mode) {
		case 'chat': {
			if (scenario.inputType === 'text') {
				const typedText = scenario.typedText ?? scenario.promptText ?? ''
				await page.getByTestId('chat-text-input').fill(typedText)
				await page.getByTestId('chat-text-send').click()
			}
			return startedAt
		}
		case 'translate': {
			if (scenario.inputType === 'text') {
				const typedText = scenario.typedText ?? scenario.promptText ?? ''
				await page.getByTestId('translate-text-input').fill(typedText)
				await page.getByTestId('translate-text-send').click()
			}
			return startedAt
		}
		default:
			return startedAt
	}
}

function collectVisibleErrorTextList(testBusEventList: ParsedLilacTestBusEvent[]): string[] {
	return testBusEventList
		.filter(isVisibleErrorEvent)
		.map(event => event.errorMessage)
		.filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function findFirstEventTimestamp(
	testBusEventList: ParsedLilacTestBusEvent[],
	predicate: (event: ParsedLilacTestBusEvent) => boolean,
	startedAt: number
): number | undefined {
	const matchedEvent = testBusEventList.find(predicate)
	if (!matchedEvent) return undefined
	return matchedEvent.occurredAt - startedAt
}

function buildLatencyMetrics(
	testBusEventList: ParsedLilacTestBusEvent[],
	scenario: EvalScenarioSpec,
	startedAt: number
): Record<string, number> {
	const latencyMetrics: Record<string, number> = {}
	if (scenario.mode === 'chat') {
		const assistantTextFirstMs = findFirstEventTimestamp(
			testBusEventList,
			event => isChatTranscriptEvent(event) && event.role === 'assistant',
			startedAt
		)
		if (typeof assistantTextFirstMs === 'number') {
			latencyMetrics.assistantTextFirstMs = assistantTextFirstMs
		}
		const assistantAudioStartMs = findFirstEventTimestamp(
			testBusEventList,
			event => isAssistantAudioStateEvent(event) && event.isPlaying,
			startedAt
		)
		if (typeof assistantAudioStartMs === 'number') {
			latencyMetrics.assistantAudioStartMs = assistantAudioStartMs
		}
		return latencyMetrics
	}
	const firstVisibleSourceMs = findFirstEventTimestamp(
		testBusEventList,
		event => isTranslateCardEvent(event) && event.sourceText.trim().length > 0,
		startedAt
	)
	if (typeof firstVisibleSourceMs === 'number') {
		latencyMetrics.firstVisibleSourceMs = firstVisibleSourceMs
	}
	const firstVisibleDraftMs = findFirstEventTimestamp(
		testBusEventList,
		event =>
			isTranslateCardEvent(event) &&
			event.renderState === 'draft' &&
			event.targetText.trim().length > 0,
		startedAt
	)
	if (typeof firstVisibleDraftMs === 'number') {
		latencyMetrics.firstVisibleDraftMs = firstVisibleDraftMs
	}
	const finalOutputMs = findFirstEventTimestamp(
		testBusEventList,
		event =>
			isTranslateCardEvent(event) &&
			event.renderState === 'final' &&
			event.targetText.trim().length > 0,
		startedAt
	)
	if (typeof finalOutputMs === 'number') {
		latencyMetrics.finalOutputMs = finalOutputMs
	}
	return latencyMetrics
}

async function waitForScenarioCompletion(page: Page, scenario: EvalScenarioSpec): Promise<void> {
	switch (scenario.mode) {
		case 'chat': {
			await waitForCondition(
				async () => {
					const eventList = await getTestBusEventList(page)
					const hasUserTranscript = eventList.some(
						event => isChatTranscriptEvent(event) && event.role === 'user'
					)
					const hasAssistantTranscript = eventList.some(
						event => isChatTranscriptEvent(event) && event.role === 'assistant'
					)
					return hasUserTranscript && hasAssistantTranscript
				},
				35_000,
				'Chat scenario did not produce user and assistant transcript output.'
			)
			return
		}
		case 'translate': {
			await waitForCondition(
				async () => {
					const eventList = await getTestBusEventList(page)
					const hasDraft = eventList.some(
						event => isTranslateCardEvent(event) && event.renderState === 'draft'
					)
					const hasFinal = eventList.some(
						event => isTranslateCardEvent(event) && event.renderState === 'final'
					)
					return hasDraft && hasFinal
				},
				35_000,
				'Translate scenario did not produce draft and final translation output.'
			)
			return
		}
		default:
			return
	}
}

async function writeJsonLines(filePath: string, entryList: unknown[]): Promise<void> {
	const fileContent = entryList.map(entry => JSON.stringify(entry)).join('\n')
	await writeFile(filePath, fileContent ? `${fileContent}\n` : '', 'utf8')
}

async function runScenario(input: {
	scenario: EvalScenarioSpec
	suiteArtifactDirectoryPath: string
	targetUrl: string
}): Promise<Omit<ScenarioObservation, 'runtimeLogMatchList'>> {
	const scenarioArtifactDirectoryPath = join(input.suiteArtifactDirectoryPath, input.scenario.id)
	const screenshotDirectoryPath = join(scenarioArtifactDirectoryPath, 'screenshots')
	const domSnapshotDirectoryPath = join(scenarioArtifactDirectoryPath, 'dom-snapshots')
	const audioArtifactDirectoryPath = join(scenarioArtifactDirectoryPath, 'audio-output')
	const bodyTextPath = join(scenarioArtifactDirectoryPath, 'body.txt')
	const pageHtmlPath = join(scenarioArtifactDirectoryPath, 'page.html')
	const rawTestBusPath = join(scenarioArtifactDirectoryPath, 'test-bus.jsonl')
	await mkdir(scenarioArtifactDirectoryPath, { recursive: true })

	const fakeAudioFixturePath =
		input.scenario.audioFixturePath && input.scenario.inputType !== 'text'
			? input.scenario.audioFixturePath
			: defaultSilentAudioFixturePath

	const browser = await chromium.launch({
		args: [
			'--use-fake-ui-for-media-stream',
			'--use-fake-device-for-media-stream',
			`--use-file-for-fake-audio-capture=${fakeAudioFixturePath}`
		],
		headless: true
	})

	let context: BrowserContext | null = null
	let collector: ScenarioArtifactCollectors | null = null
	let page: Page | null = null
	const harnessFailureList: string[] = []
	try {
		context = await browser.newContext({
			permissions: ['microphone'],
			viewport: input.scenario.targetViewport ?? defaultViewport
		})
		page = await context.newPage()
		await installEvalCaptureHooks(page)
		collector = await startScenarioArtifactCollectors(page, scenarioArtifactDirectoryPath)
		let startedAt = Date.now()
		try {
			await page.goto(input.targetUrl, { timeout: 120_000, waitUntil: 'domcontentloaded' })
			await configureScenario(page, input.scenario)
			startedAt = await submitScenarioInput(page, input.scenario)
			if (input.scenario.mode === 'chat') {
				await waitForCondition(
					async () => await maybeStartAssistantAudioRecorder(page as Page),
					20_000,
					'Assistant audio recorder could not attach to remote audio stream.'
				).catch(() => {})
			}
			await waitForScenarioCompletion(page, input.scenario)
			await page.waitForTimeout(1200)
		} catch (error) {
			harnessFailureList.push(error instanceof Error ? error.message : 'Scenario execution failed.')
		}
		const assistantAudioArtifactPath =
			input.scenario.mode === 'chat' && page
				? await stopAssistantAudioRecorder(page, audioArtifactDirectoryPath, input.scenario.id)
				: null
		const testBusEventList = page ? await getTestBusEventList(page).catch(() => []) : []
		const bodyText = page
			? await page
					.locator('body')
					.innerText()
					.catch(() => '')
			: ''
		const domHtml = page ? await page.content().catch(() => '') : ''
		const latencyMetrics = buildLatencyMetrics(testBusEventList, input.scenario, startedAt)
		const consoleLogPath = join(scenarioArtifactDirectoryPath, 'browser-console.log')
		const clientTimelinePath = join(scenarioArtifactDirectoryPath, 'client-timeline.jsonl')
		const transcriptTimelinePath = join(scenarioArtifactDirectoryPath, 'transcript-timeline.jsonl')
		const translationTimelinePath = join(scenarioArtifactDirectoryPath, 'translation-timeline.jsonl')
		const consoleEntryList = collector?.consoleEntryList ?? []
		await writeFile(bodyTextPath, bodyText, 'utf8')
		await writeFile(pageHtmlPath, domHtml, 'utf8')
		await writeFile(consoleLogPath, `${consoleEntryList.join('\n')}\n`, 'utf8')
		await writeJsonLines(clientTimelinePath, testBusEventList)
		await writeJsonLines(rawTestBusPath, testBusEventList)
		await writeJsonLines(
			transcriptTimelinePath,
			testBusEventList.filter(event => isChatTranscriptEvent(event) || isSubtitleStateEvent(event))
		)
		await writeJsonLines(translationTimelinePath, testBusEventList.filter(isTranslateCardEvent))
		return {
			artifactBundle: {
				artifactDirectoryPath: scenarioArtifactDirectoryPath,
				...(assistantAudioArtifactPath ? { assistantAudioArtifactPath } : {}),
				bodyTextPath,
				browserConsoleLogPath: consoleLogPath,
				clientTimelinePath,
				domSnapshotDirectoryPath,
				mode: input.scenario.mode,
				pageHtmlPath,
				rawTestBusPath,
				scenarioId: input.scenario.id,
				screenshotDirectoryPath,
				targetUrl: input.targetUrl,
				transcriptTimelinePath,
				translationTimelinePath
			},
			bodyText,
			browserConsoleEntryList: consoleEntryList,
			domHtml,
			errorTextList: collectVisibleErrorTextList(testBusEventList),
			harnessFailureList,
			latencyMetrics,
			scenario: input.scenario,
			testBusEventList,
			...(assistantAudioArtifactPath ? { assistantAudioArtifactPath } : {})
		}
	} finally {
		if (collector) await collector.stop()
		if (context) await context.close()
		await browser.close()
	}
}

async function runMobileLayoutChecks(input: {
	suiteArtifactDirectoryPath: string
	targetUrl: string
}): Promise<string[]> {
	const findingList: string[] = []
	const artifactDirectoryPath = join(input.suiteArtifactDirectoryPath, 'mobile-layout')
	await mkdir(artifactDirectoryPath, { recursive: true })
	for (const colorScheme of ['light', 'dark'] as const) {
		for (const viewport of mobileViewportList) {
			const browser: Browser = await chromium.launch({ headless: true })
			const context = await browser.newContext({
				colorScheme,
				permissions: ['microphone'],
				viewport
			})
			const page = await context.newPage()
			try {
				await page.goto(input.targetUrl, { timeout: 120_000, waitUntil: 'domcontentloaded' })
				await switchToModeWithRetry(page, 'translate')
				const hasHorizontalOverflow = await page.evaluate(() => {
					return document.documentElement.scrollWidth > window.innerWidth + 1
				})
				const hasVerticalGrowth = await page.evaluate(() => {
					return document.documentElement.scrollHeight > window.innerHeight + 1
				})
				const screenshotPath = join(
					artifactDirectoryPath,
					`${colorScheme}-${viewport.width}x${viewport.height}.png`
				)
				await page.screenshot({ fullPage: true, path: screenshotPath })
				if (hasHorizontalOverflow) {
					findingList.push(`horizontal overflow at ${colorScheme} ${viewport.width}x${viewport.height}`)
				}
				if (hasVerticalGrowth) {
					findingList.push(
						`vertical document growth at ${colorScheme} ${viewport.width}x${viewport.height}`
					)
				}
			} finally {
				await context.close()
				await browser.close()
			}
		}
	}
	return findingList
}

export function selectCandidateConfig(
	candidateConfigList: EvalCandidateConfig[],
	candidateId: string
): EvalCandidateConfig {
	const selectedCandidateConfig = candidateConfigList.find(
		candidateConfig => candidateConfig.id === candidateId
	)
	if (!selectedCandidateConfig) {
		throw new Error(`Unknown candidate ID: ${candidateId}`)
	}
	return selectedCandidateConfig
}

function buildFailureClusterList(
	scenarioJudgmentList: Array<{
		scenarioId: string
		severity: 'high' | 'low' | 'medium'
		reason: string
	}>
) {
	return scenarioJudgmentList.map((scenarioJudgment, index) => ({
		clusterId: `cluster-${String(index + 1).padStart(2, '0')}`,
		reason: scenarioJudgment.reason,
		scenarioIds: [scenarioJudgment.scenarioId],
		severity: scenarioJudgment.severity
	}))
}

export async function loadEvalMatrix(matrixPath: string) {
	const matrixContent = await readFile(matrixPath, 'utf8')
	return EvalMatrixSchema.parse(JSON.parse(matrixContent))
}

export async function executeEvalSuite(input: EvalRunOptions): Promise<EvalRunExecution> {
	const evaluationId = input.evaluationId ?? createEvaluationId()
	const suiteArtifactDirectoryPath = resolve(
		process.cwd(),
		'.artifacts/evals',
		createTimestampLabel(),
		evaluationId
	)
	await mkdir(suiteArtifactDirectoryPath, { recursive: true })
	await mkdir(dirname(defaultSilentAudioFixturePath), { recursive: true })

	let runtimeLogCapture: RuntimeLogCapture | null = null
	if (input.captureVercelLogs) {
		runtimeLogCapture = await startVercelRuntimeLogCapture({
			artifactDirectoryPath: suiteArtifactDirectoryPath,
			deploymentDomain: new URL(input.targetUrl).host,
			...(process.env.VERCEL_TOKEN ? { vercelToken: process.env.VERCEL_TOKEN } : {})
		})
	}

	const scenarioList = resolveEvalScenarioList(input.scenarioIdList)
	await ensureAudioFixturesReady(scenarioList)
	const observationList: ScenarioObservation[] = []
	try {
		for (const scenario of scenarioList) {
			const observation = await runScenario({
				scenario,
				suiteArtifactDirectoryPath,
				targetUrl: input.targetUrl
			})
			observationList.push({
				...observation,
				runtimeLogMatchList: []
			})
		}
	} finally {
		if (runtimeLogCapture) await runtimeLogCapture.stop()
	}

	const runtimeLogMatchList = runtimeLogCapture
		? await collectRuntimeErrorMatches(runtimeLogCapture.stdoutPath)
		: []
	for (const observation of observationList) {
		observation.runtimeLogMatchList = runtimeLogMatchList
		observation.artifactBundle = {
			...observation.artifactBundle,
			...(runtimeLogCapture ? { runtimeLogPath: runtimeLogCapture.stdoutPath } : {}),
			...(runtimeLogCapture ? { runtimeStderrPath: runtimeLogCapture.stderrPath } : {})
		}
	}
	const layoutFindingList = await runMobileLayoutChecks({
		suiteArtifactDirectoryPath,
		targetUrl: input.targetUrl
	})

	const scenarioRunSummaryList = [] as z.infer<typeof EvalScenarioRunSummarySchema>[]
	const suiteJudgeResultList = [] as Array<
		z.infer<typeof EvalRunSummarySchema>['scorecard']['judgeResults'][number]
	>
	const suiteHardGateFindingList = [] as z.infer<
		typeof EvalRunSummarySchema
	>['scorecard']['hardGateResults']
	const failureClusterSeedList: Array<{
		scenarioId: string
		severity: 'high' | 'low' | 'medium'
		reason: string
	}> = []

	for (const observation of observationList) {
		observation.runtimeLogMatchList = runtimeLogMatchList
		const hardGuardrailJudgment = await runHardGuardrailJudge(observation)
		const audioInputJudgeResult = await runAudioInputReferenceJudge(observation)
		const audioOutputJudgeResult = await runAudioOutputListenerJudge(observation)
		const visualJudgeResult = await runVisualUiJudge(observation)
		const semanticJudgeResult = await runSemanticConversationJudge(observation)
		const judgeResultList = [
			...hardGuardrailJudgment.judgeResultList,
			audioInputJudgeResult,
			audioOutputJudgeResult,
			visualJudgeResult,
			semanticJudgeResult
		]
		const scorecard = buildScenarioScorecard({
			hardGateFindingList: hardGuardrailJudgment.hardGateFindingList,
			judgeResultList
		})
		scenarioRunSummaryList.push(
			EvalScenarioRunSummarySchema.parse({
				artifactBundle: observation.artifactBundle,
				latencyMetrics: observation.latencyMetrics,
				scenario: observation.scenario,
				scorecard
			})
		)
		suiteJudgeResultList.push(...judgeResultList)
		suiteHardGateFindingList.push(...hardGuardrailJudgment.hardGateFindingList)
		for (const failureClusterReason of hardGuardrailJudgment.failureClusterReasonList) {
			failureClusterSeedList.push({
				reason: failureClusterReason.reason,
				scenarioId: observation.scenario.id,
				severity: failureClusterReason.severity
			})
		}
	}

	for (const layoutFinding of layoutFindingList) {
		suiteHardGateFindingList.push({
			code: 'mobile_layout_regression',
			details: layoutFinding,
			severity: 'medium'
		})
		failureClusterSeedList.push({
			reason: layoutFinding,
			scenarioId: 'mobile-layout',
			severity: 'medium'
		})
	}

	const suiteAggregateScore =
		suiteJudgeResultList.reduce((scoreSum, judgeResult) => scoreSum + judgeResult.score, 0) /
		Math.max(1, suiteJudgeResultList.length)
	const suiteReleaseDecision =
		suiteHardGateFindingList.some(finding => finding.severity === 'high') ||
		suiteJudgeResultList.some(judgeResult => !judgeResult.passed) ||
		suiteJudgeResultList.some(judgeResult =>
			judgeResult.findings.some(finding => finding.severity === 'high')
		)
			? 'block'
			: suiteAggregateScore >= 0.92
				? 'promote'
				: suiteAggregateScore >= 0.75
					? 'candidate'
					: 'block'
	const failureClusterList = buildFailureClusterList(failureClusterSeedList)
	const runSummary = EvalRunSummarySchema.parse({
		appCommitSha: getGitCommitSha(),
		artifactDirectoryPath: suiteArtifactDirectoryPath,
		candidateConfig: input.candidateConfig,
		deployedUrl: input.targetUrl,
		evaluationId,
		failureClusterList,
		scenarioRunSummaryList,
		scorecard: {
			aggregateScore: Math.round(suiteAggregateScore * 1000) / 1000,
			hardGateResults: suiteHardGateFindingList,
			judgeResults: suiteJudgeResultList,
			regressionDeltas: {},
			releaseDecision: suiteReleaseDecision
		},
		startedAtIso: new Date().toISOString()
	})

	const summaryPath = join(suiteArtifactDirectoryPath, 'summary.json')
	await writeFile(summaryPath, JSON.stringify(runSummary, null, 2), 'utf8')
	const leaderboardPath = resolve(process.cwd(), '.artifacts/evals/leaderboard.json')
	let previousLeaderboard: unknown[] = []
	try {
		previousLeaderboard = JSON.parse(await readFile(leaderboardPath, 'utf8')) as unknown[]
	} catch {
		previousLeaderboard = []
	}
	await mkdir(dirname(leaderboardPath), { recursive: true })
	await writeFile(
		leaderboardPath,
		JSON.stringify(
			[
				...previousLeaderboard,
				{
					aggregateScore: runSummary.scorecard.aggregateScore,
					artifactDirectoryPath: runSummary.artifactDirectoryPath,
					candidateId: runSummary.candidateConfig.id,
					deployedUrl: runSummary.deployedUrl,
					evaluationId: runSummary.evaluationId,
					releaseDecision: runSummary.scorecard.releaseDecision,
					startedAtIso: runSummary.startedAtIso
				}
			],
			null,
			2
		),
		'utf8'
	)
	await writeFile(
		join(suiteArtifactDirectoryPath, 'observations.json'),
		JSON.stringify(
			observationList.map(observation => ({
				artifactBundle: observation.artifactBundle,
				bodyText: observation.bodyText,
				errorTextList: observation.errorTextList,
				latencyMetrics: observation.latencyMetrics,
				runtimeLogMatchList: observation.runtimeLogMatchList,
				scenarioId: observation.scenario.id
			})),
			null,
			2
		),
		'utf8'
	)

	return {
		observationList,
		runSummary
	}
}

export async function runEvalSuite(input: EvalRunOptions): Promise<EvalRunSummary> {
	const execution = await executeEvalSuite(input)
	return execution.runSummary
}

async function main(): Promise<void> {
	const parsedArguments = parseArguments(process.argv.slice(2))
	const evalMatrix = await loadEvalMatrix(parsedArguments.matrixPath)
	const candidateConfig = selectCandidateConfig(
		[evalMatrix.baseline, ...evalMatrix.candidateList],
		parsedArguments.candidateId
	)
	const runSummary = await runEvalSuite({
		candidateConfig,
		captureVercelLogs: parsedArguments.captureVercelLogs,
		targetUrl: parsedArguments.targetUrl,
		...(parsedArguments.evaluationId ? { evaluationId: parsedArguments.evaluationId } : {}),
		...(parsedArguments.scenarioIdList ? { scenarioIdList: parsedArguments.scenarioIdList } : {})
	})
	console.log(JSON.stringify(runSummary, null, 2))
	if (runSummary.scorecard.releaseDecision === 'block') {
		throw new Error('Eval suite failed.')
	}
}

if (import.meta.main) {
	void main().catch(error => {
		console.error(error instanceof Error ? error.message : 'Eval suite failed.')
		process.exit(1)
	})
}
