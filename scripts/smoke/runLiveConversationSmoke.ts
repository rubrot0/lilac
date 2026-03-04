import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'

import {
	collectRuntimeErrorMatches,
	type RuntimeLogCapture,
	startVercelRuntimeLogCapture
} from './captureVercelRuntimeLogs'

type SmokeMode = 'chat' | 'translate'

type SmokeRunOptions = {
	audioPath: string
	captureVercelLogs: boolean
	runChatScenario: boolean
	targetUrl: string
}

type ScenarioResult = {
	failures: string[]
	mode: SmokeMode
}

const genericServerComponentErrorText =
	'An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.'
const missingSessionTypeErrorText = "Missing required parameter: 'session.type'."
const invalidItemIdErrorText = "Invalid 'item.id':"
const missingToolCallErrorTextList = [
	'No valid publish_translation tool call was returned.',
	'No publish_translation tool call was returned for the completed turn.'
]
const trackedProtocolErrorTextList = [
	missingSessionTypeErrorText,
	invalidItemIdErrorText,
	...missingToolCallErrorTextList
]
const maxTranslateFinalizationLatencyMilliseconds = 30_000

const mobileViewports = [
	{ height: 812, width: 375 },
	{ height: 844, width: 390 }
] as const

function parseArguments(argumentList: string[]): SmokeRunOptions {
	const parsedOptions: SmokeRunOptions = {
		audioPath: resolve(process.cwd(), '.artifacts/smoke/fixtures/conversation_smoke.wav'),
		captureVercelLogs: true,
		runChatScenario: true,
		targetUrl: 'https://lilac.chat'
	}

	for (let argumentIndex = 0; argumentIndex < argumentList.length; argumentIndex += 1) {
		const argument = argumentList[argumentIndex]
		switch (argument) {
			case '--target-url': {
				parsedOptions.targetUrl = argumentList[argumentIndex + 1] ?? parsedOptions.targetUrl
				argumentIndex += 1
				continue
			}
			case '--audio-path': {
				parsedOptions.audioPath = resolve(argumentList[argumentIndex + 1] ?? parsedOptions.audioPath)
				argumentIndex += 1
				continue
			}
			case '--skip-vercel-logs': {
				parsedOptions.captureVercelLogs = false
				continue
			}
			case '--skip-chat': {
				parsedOptions.runChatScenario = false
				continue
			}
			default:
				continue
		}
	}

	return parsedOptions
}

function createTimestampLabel(): string {
	return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
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

async function waitForConnectionLive(page: Page): Promise<void> {
	await page.waitForTimeout(1800)
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

async function openGlobalSettings(page: Page): Promise<void> {
	const desktopButton = page.getByTestId('global-settings-open-desktop')
	if (await desktopButton.isVisible().catch(() => false)) {
		await desktopButton.click()
		return
	}
	await page.getByTestId('global-settings-open-mobile').click()
}

async function closeOverlayIfPresent(page: Page): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const overlayCount = await page.locator('[data-state="open"][aria-hidden="true"]').count()
		if (overlayCount === 0) return
		await page.keyboard.press('Escape').catch(() => {})
		await page.waitForTimeout(120)
	}
}

async function writeScenarioArtifacts(
	page: Page,
	artifactDirectoryPath: string,
	mode: SmokeMode
): Promise<string> {
	const modeDirectoryPath = join(artifactDirectoryPath, mode)
	await mkdir(modeDirectoryPath, { recursive: true })
	const screenshotPath = join(modeDirectoryPath, 'screenshot.png')
	const bodyTextPath = join(modeDirectoryPath, 'body.txt')
	const htmlPath = join(modeDirectoryPath, 'page.html')

	await page.screenshot({ fullPage: true, path: screenshotPath })
	const bodyText = await page.locator('body').innerText()
	await writeFile(bodyTextPath, bodyText, 'utf8')
	await writeFile(htmlPath, await page.content(), 'utf8')

	return bodyText
}

function collectProtocolErrorText(bodyText: string): string[] {
	return trackedProtocolErrorTextList.filter(errorText => bodyText.includes(errorText))
}

async function clickSliderByRatio(page: Page, testId: string, ratio: number): Promise<void> {
	const sliderLocator = page.getByTestId(testId)
	await sliderLocator.waitFor({ state: 'visible', timeout: 15_000 })
	const sliderBox = await sliderLocator.boundingBox()
	if (!sliderBox) throw new Error(`Unable to locate slider bounds for ${testId}.`)

	const normalizedRatio = Math.max(0, Math.min(1, ratio))
	const clickX = sliderBox.x + sliderBox.width * normalizedRatio
	const clickY = sliderBox.y + sliderBox.height / 2
	await page.mouse.click(clickX, clickY)
}

async function runChatScenario(page: Page, artifactDirectoryPath: string): Promise<ScenarioResult> {
	const failures: string[] = []
	const typedMessage = `typed smoke ${Date.now()}`
	try {
		await switchToModeWithRetry(page, 'chat')
		await waitForConnectionLive(page)

		await openGlobalSettings(page)
		await clickSliderByRatio(page, 'chat-turn-delay-slider', 0.68)
		await page.waitForTimeout(800)

		const bodyTextAfterSliderUpdate = await page.locator('body').innerText()
		if (bodyTextAfterSliderUpdate.includes(missingSessionTypeErrorText)) {
			throw new Error('Chat slider interaction triggered session.type error.')
		}

		await closeOverlayIfPresent(page)
		await page.getByTestId('chat-text-input').fill(typedMessage)
		await page.getByTestId('chat-text-send').click()

		await waitForCondition(
			async function hasVisibleTypedMessage(): Promise<boolean> {
				const visibleCount = await page
					.locator('[data-testid^="chat-message-text-"]')
					.filter({ hasText: typedMessage })
					.count()
				return visibleCount > 0
			},
			20_000,
			'Typed chat message was not appended to visible transcript.'
		)

		await waitForCondition(
			async function hasAssistantMessage(): Promise<boolean> {
				const messageTextList = await page
					.locator('[data-testid^="chat-message-text-"]')
					.allInnerTexts()
				return messageTextList.some(messageText => !messageText.includes(typedMessage))
			},
			35_000,
			'Chat mode did not produce a follow-up assistant transcript.'
		)
	} catch (error) {
		failures.push(error instanceof Error ? error.message : 'Chat mode validation failed.')
	}

	const bodyText = await writeScenarioArtifacts(page, artifactDirectoryPath, 'chat')
	if (bodyText.includes(genericServerComponentErrorText)) {
		failures.push('Chat mode rendered generic Server Components error text.')
	}
	const protocolErrors = collectProtocolErrorText(bodyText)
	for (const protocolError of protocolErrors) {
		failures.push(`Chat mode rendered protocol error text: ${protocolError}`)
	}

	return {
		failures,
		mode: 'chat'
	}
}

async function runTranslateScenario(
	page: Page,
	artifactDirectoryPath: string
): Promise<ScenarioResult> {
	const failures: string[] = []
	let connectionFailureMessage: null | string = null
	try {
		await closeOverlayIfPresent(page)
		await switchToModeWithRetry(page, 'translate')
		try {
			await waitForConnectionLive(page)
		} catch (error) {
			connectionFailureMessage =
				error instanceof Error ? error.message : 'Translate mode connection did not become live.'
		}

		await page.getByTestId('translate-language-picker-open-desktop').click()
		await page.getByTestId('translate-secondary-language-search').fill('French')
		await page.getByTestId('translate-secondary-language-option-fr').click()
		await page.keyboard.press('Escape')
		await page.waitForTimeout(1000)
		const bodyTextAfterLanguageChange = await page.locator('body').innerText()
		if (bodyTextAfterLanguageChange.includes(missingSessionTypeErrorText)) {
			throw new Error('Translate language change triggered session.type error.')
		}
		if (
			bodyTextAfterLanguageChange.includes('AUDIO') ||
			bodyTextAfterLanguageChange.includes('FINAL')
		) {
			throw new Error('Translate mode rendered internal status chips in user-facing UI.')
		}

		const translateStartTime = Date.now()
		await waitForCondition(
			async function hasTranslateCard(): Promise<boolean> {
				const cardCount = await page.locator('[data-testid^="translate-card-"]').count()
				if (cardCount === 0) return false
				const targetTextList = await page
					.locator('[data-testid^="translate-card-target-"]')
					.allInnerTexts()
				return targetTextList.some(targetText => {
					const normalizedText = targetText.trim()
					if (!normalizedText) return false
					if (normalizedText === 'Translating…') return false
					if (normalizedText === 'Translating...') return false
					return true
				})
			},
			20_000,
			'Translate mode did not produce finalized translation output.'
		)
		const translateLatencyMilliseconds = Date.now() - translateStartTime
		if (translateLatencyMilliseconds > maxTranslateFinalizationLatencyMilliseconds) {
			throw new Error(
				`Translate mode finalized too slowly (${translateLatencyMilliseconds}ms > ${maxTranslateFinalizationLatencyMilliseconds}ms).`
			)
		}

		const subtitleRailText = await page.getByTestId('translate-live-subtitle-rail').innerText()
		if (!subtitleRailText.trim()) {
			throw new Error('Translate subtitle rail did not render text.')
		}
	} catch (error) {
		failures.push(error instanceof Error ? error.message : 'Translate mode validation failed.')
	}
	if (failures.length === 0 && connectionFailureMessage) {
		console.warn(connectionFailureMessage)
	}

	const bodyText = await writeScenarioArtifacts(page, artifactDirectoryPath, 'translate')
	if (bodyText.includes(genericServerComponentErrorText)) {
		failures.push('Translate mode rendered generic Server Components error text.')
	}
	const protocolErrors = collectProtocolErrorText(bodyText)
	for (const protocolError of protocolErrors) {
		failures.push(`Translate mode rendered protocol error text: ${protocolError}`)
	}

	return {
		failures,
		mode: 'translate'
	}
}

async function runMobileThemeChecks(
	browser: Browser,
	artifactDirectoryPath: string,
	targetUrl: string
): Promise<string[]> {
	const failures: string[] = []
	const layoutDirectoryPath = join(artifactDirectoryPath, 'layout')
	await mkdir(layoutDirectoryPath, { recursive: true })

	for (const colorScheme of ['light', 'dark'] as const) {
		for (const viewport of mobileViewports) {
			let context: BrowserContext | null = null
			try {
				context = await browser.newContext({
					colorScheme,
					permissions: ['microphone'],
					viewport
				})
				const page = await context.newPage()
				await page.goto(targetUrl, { timeout: 120_000, waitUntil: 'domcontentloaded' })

				await switchToModeWithRetry(page, 'translate')

				const hasHorizontalOverflow = await page.evaluate(function detectOverflow(): boolean {
					return document.documentElement.scrollWidth > window.innerWidth + 1
				})
				const hasDocumentVerticalGrowth = await page.evaluate(function detectVerticalGrowth(): boolean {
					return document.documentElement.scrollHeight > window.innerHeight + 1
				})
				const bodyText = await page.locator('body').innerText()

				const screenshotPath = join(
					layoutDirectoryPath,
					`${colorScheme}-${viewport.width}x${viewport.height}.png`
				)
				await page.screenshot({ fullPage: true, path: screenshotPath })

				if (hasHorizontalOverflow) {
					failures.push(
						`layout-${colorScheme}-${viewport.width}x${viewport.height}: horizontal overflow detected`
					)
				}
				if (hasDocumentVerticalGrowth) {
					failures.push(
						`layout-${colorScheme}-${viewport.width}x${viewport.height}: document vertical growth detected`
					)
				}
				if (bodyText.includes(genericServerComponentErrorText)) {
					failures.push(
						`layout-${colorScheme}-${viewport.width}x${viewport.height}: generic Server Components error text rendered`
					)
				}
				for (const protocolError of collectProtocolErrorText(bodyText)) {
					failures.push(
						`layout-${colorScheme}-${viewport.width}x${viewport.height}: protocol error text rendered: ${protocolError}`
					)
				}
			} catch (error) {
				failures.push(
					`layout-${colorScheme}-${viewport.width}x${viewport.height}: ${
						error instanceof Error ? error.message : 'layout check failed'
					}`
				)
			} finally {
				if (context) await context.close()
			}
		}
	}

	return failures
}

async function resolveRuntimeMatches(
	logCapture: null | RuntimeLogCapture
): Promise<{ matches: string[]; stderrTail: string }> {
	if (!logCapture) return { matches: [], stderrTail: '' }

	const matches = await collectRuntimeErrorMatches(logCapture.stdoutPath)
	const stderrContent = await readFile(logCapture.stderrPath, 'utf8')
	const stderrLines = stderrContent
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.slice(-20)

	return {
		matches,
		stderrTail: stderrLines.join('\n')
	}
}

async function main(): Promise<void> {
	const options = parseArguments(process.argv.slice(2))
	const artifactDirectoryPath = resolve(process.cwd(), '.artifacts/smoke', createTimestampLabel())
	await mkdir(artifactDirectoryPath, { recursive: true })
	await mkdir(dirname(options.audioPath), { recursive: true })

	let logCapture: null | RuntimeLogCapture = null
	if (options.captureVercelLogs) {
		const runtimeCaptureInput = {
			artifactDirectoryPath,
			deploymentDomain: new URL(options.targetUrl).host,
			...(process.env.VERCEL_TOKEN ? { vercelToken: process.env.VERCEL_TOKEN } : {})
		}
		logCapture = await startVercelRuntimeLogCapture({
			...runtimeCaptureInput
		})
	}

	const browser = await chromium.launch({
		args: [
			'--use-fake-ui-for-media-stream',
			'--use-fake-device-for-media-stream',
			`--use-file-for-fake-audio-capture=${options.audioPath}`
		],
		headless: true
	})

	const failureMessages: string[] = []
	const scenarioResults: ScenarioResult[] = []

	try {
		const pageContext = await browser.newContext({
			permissions: ['microphone']
		})
		const page = await pageContext.newPage()
		await page.goto(options.targetUrl, { timeout: 120_000, waitUntil: 'domcontentloaded' })

		if (options.runChatScenario) {
			scenarioResults.push(await runChatScenario(page, artifactDirectoryPath))
		}
		scenarioResults.push(await runTranslateScenario(page, artifactDirectoryPath))
		await pageContext.close()

		const layoutFailures = await runMobileThemeChecks(
			browser,
			artifactDirectoryPath,
			options.targetUrl
		)
		failureMessages.push(...layoutFailures)
	} finally {
		await browser.close()
		if (logCapture) await logCapture.stop()
	}

	for (const scenarioResult of scenarioResults) {
		for (const failureMessage of scenarioResult.failures) {
			failureMessages.push(`${scenarioResult.mode}: ${failureMessage}`)
		}
	}

	const runtimeSummary = await resolveRuntimeMatches(logCapture)
	for (const runtimeMatch of runtimeSummary.matches) {
		failureMessages.push(`runtime-log: ${runtimeMatch}`)
	}

	const summary = {
		artifactDirectoryPath,
		failures: failureMessages,
		runtimeLog: logCapture
			? {
					stderrPath: logCapture.stderrPath,
					stderrTail: runtimeSummary.stderrTail,
					stdoutPath: logCapture.stdoutPath
				}
			: null,
		scenarios: scenarioResults
	}

	await writeFile(
		join(artifactDirectoryPath, 'summary.json'),
		JSON.stringify(summary, null, 2),
		'utf8'
	)
	console.log(JSON.stringify(summary, null, 2))

	if (failureMessages.length > 0) {
		throw new Error(`Smoke run failed with ${failureMessages.length} failure(s).`)
	}
}

void main().catch(error => {
	console.error(error instanceof Error ? error.message : 'Smoke runner failed.')
	process.exit(1)
})
