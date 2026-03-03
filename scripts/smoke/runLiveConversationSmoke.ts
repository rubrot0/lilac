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
	await waitForCondition(
		async function hasLiveBadge(): Promise<boolean> {
			const badgeText = await page.getByTestId('connection-state-badge').innerText()
			return badgeText.toLowerCase().includes('live')
		},
		45_000,
		'Connection did not become live within timeout.'
	)
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

async function runChatScenario(page: Page, artifactDirectoryPath: string): Promise<ScenarioResult> {
	const failures: string[] = []
	try {
		await page.getByTestId('mode-tab-chat').click()
		await waitForConnectionLive(page)
		await waitForCondition(
			async function hasChatMessages(): Promise<boolean> {
				const messageCount = await page.locator('[data-testid^="chat-message-"]').count()
				return messageCount > 0
			},
			35_000,
			'Chat mode did not receive transcript messages.'
		)
	} catch (error) {
		failures.push(error instanceof Error ? error.message : 'Chat mode validation failed.')
	}

	const bodyText = await writeScenarioArtifacts(page, artifactDirectoryPath, 'chat')
	if (bodyText.includes(genericServerComponentErrorText)) {
		failures.push('Chat mode rendered generic Server Components error text.')
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
		await page.getByTestId('mode-tab-translate').click()
		try {
			await waitForConnectionLive(page)
		} catch (error) {
			connectionFailureMessage =
				error instanceof Error ? error.message : 'Translate mode connection did not become live.'
		}
		await waitForCondition(
			async function hasTranslateCard(): Promise<boolean> {
				const cardCount = await page.locator('[data-testid^="translate-card-"]').count()
				if (cardCount === 0) return false
				const targetText = await page
					.locator('[data-testid^="translate-card-target-"]')
					.first()
					.innerText()
				return targetText.trim().length > 0
			},
			45_000,
			'Translate mode did not produce translation card output.'
		)
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

				await page.getByTestId('mode-tab-translate').click()
				await waitForCondition(
					async function hasTranslateModeBadge(): Promise<boolean> {
						const modeBadgeText = await page.getByTestId('mode-active-badge').innerText()
						return modeBadgeText.toLowerCase().includes('translate')
					},
					10_000,
					'Mode switch to translate did not complete.'
				)

				const hasHorizontalOverflow = await page.evaluate(function detectOverflow(): boolean {
					return document.documentElement.scrollWidth > window.innerWidth + 1
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
				if (bodyText.includes(genericServerComponentErrorText)) {
					failures.push(
						`layout-${colorScheme}-${viewport.width}x${viewport.height}: generic Server Components error text rendered`
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
