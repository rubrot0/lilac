import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
	EvalScorecardSchema,
	type FlywheelPatchProposal,
	FlywheelPatchProposalSchema,
	type JudgeFinding,
	type JudgeResult,
	JudgeResultSchema
} from '@/evals/contracts'
import {
	createChatCompletionJson,
	createResponsesJson,
	readAudioFileAsBase64,
	transcribeAudioFile
} from './openAiClient'
import type { ScenarioJudgment, ScenarioObservation } from './runtimeTypes'

const genericServerComponentErrorText =
	'An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.'
const trackedProtocolPatternList = [
	/Unsupported parameter/i,
	/Unknown parameter/i,
	/Missing required parameter/i,
	/No valid publish_translation tool call/i,
	/No publish_translation tool call was returned/i,
	/Invalid 'item\.id'/i,
	/buffer too small/i,
	/Unhandled/i
]

const LooseJudgeFindingSchema = z.object({
	code: z.string().min(1),
	details: z.string().min(1),
	severity: z.string().min(1)
})

const LooseModelJudgeSchema = z.object({
	confidence: z.union([z.number(), z.string()]).optional(),
	findings: z.array(LooseJudgeFindingSchema).default([]),
	passed: z.union([z.boolean(), z.string()]).optional(),
	rationale: z.string().min(1),
	score: z.union([z.number(), z.string()]).optional()
})

const VisualUiJudgeSchema = LooseModelJudgeSchema
const SemanticJudgeSchema = LooseModelJudgeSchema

const RootCauseSynthesisSchema = z.object({
	allowlistedSurfaceList: z.array(z.string().min(1)).min(1),
	confidence: z.number().min(0).max(1),
	failureClusterIds: z.array(z.string().min(1)).min(1),
	filePathList: z.array(z.string().min(1)).default([]),
	prompt: z.string().min(1),
	reasoning: z.string().min(1),
	summary: z.string().min(1)
})

type ChatTranscriptEvent = Extract<
	ScenarioObservation['testBusEventList'][number],
	{ eventType: 'chat_transcript_patch' }
>
type TranslateCardEvent = Extract<
	ScenarioObservation['testBusEventList'][number],
	{ eventType: 'translate_card_patch' }
>

function isChatTranscriptEvent(
	event: ScenarioObservation['testBusEventList'][number]
): event is ChatTranscriptEvent {
	return event.eventType === 'chat_transcript_patch'
}

function isTranslateCardEvent(
	event: ScenarioObservation['testBusEventList'][number]
): event is TranslateCardEvent {
	return event.eventType === 'translate_card_patch'
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim()
}

function canonicalizeText(value: string): string {
	const normalizedValue = normalizeWhitespace(value).toLowerCase()
	let canonicalValue = ''
	for (const character of normalizedValue) {
		const isAsciiDigit = character >= '0' && character <= '9'
		const isUnicodeLetter = character.toLowerCase() !== character.toUpperCase()
		const isSpace = character === ' '
		if (isAsciiDigit || isUnicodeLetter || isSpace) {
			canonicalValue += character
		}
	}
	return canonicalValue
}

function computeTokenOverlapScore(expectedText: string, observedText: string): number {
	const expectedTokenList = canonicalizeText(expectedText).split(' ').filter(Boolean)
	const observedTokenList = canonicalizeText(observedText).split(' ').filter(Boolean)
	if (expectedTokenList.length === 0 || observedTokenList.length === 0) return 0
	const observedTokenSet = new Set(observedTokenList)
	let sharedTokenCount = 0
	for (const expectedToken of expectedTokenList) {
		if (observedTokenSet.has(expectedToken)) sharedTokenCount += 1
	}
	return Math.min(1, sharedTokenCount / expectedTokenList.length)
}

function createJudgeResult(input: JudgeResult): JudgeResult {
	return JudgeResultSchema.parse(input)
}

function normalizeJudgeScore(value: number): number {
	if (!Number.isFinite(value)) return 0
	if (value > 1 && value <= 10) return Math.max(0, Math.min(1, value / 10))
	if (value > 10 && value <= 100) return Math.max(0, Math.min(1, value / 100))
	return Math.max(0, Math.min(1, value))
}

function parseNumberLikeValue(value: number | string | undefined): number {
	if (typeof value === 'number') return value
	if (typeof value === 'string') {
		const trimmedValue = value.trim().replace(/%$/, '')
		const parsedValue = Number.parseFloat(trimmedValue)
		return Number.isFinite(parsedValue) ? parsedValue : 0
	}
	return 0
}

function parseBooleanLikeValue(
	value: boolean | string | undefined,
	fallbackValue: boolean
): boolean {
	if (typeof value === 'boolean') return value
	if (typeof value === 'string') {
		const normalizedValue = value.trim().toLowerCase()
		if (normalizedValue === 'true' || normalizedValue === 'pass' || normalizedValue === 'passed')
			return true
		if (normalizedValue === 'false' || normalizedValue === 'fail' || normalizedValue === 'failed')
			return false
	}
	return fallbackValue
}

function containsNegativeJudgmentSignal(value: string): boolean {
	const normalizedValue = value.toLowerCase()
	return (
		normalizedValue.includes('no ') ||
		normalizedValue.includes('not ') ||
		normalizedValue.includes('missing') ||
		normalizedValue.includes('cannot') ||
		normalizedValue.includes('impossible') ||
		normalizedValue.includes('failed') ||
		normalizedValue.includes('did not')
	)
}

function containsPositiveJudgmentSignal(value: string): boolean {
	const normalizedValue = value.toLowerCase()
	return (
		normalizedValue.includes('accurate') ||
		normalizedValue.includes('appropriate') ||
		normalizedValue.includes('clear') ||
		normalizedValue.includes('correct') ||
		normalizedValue.includes('good') ||
		normalizedValue.includes('intuitive') ||
		normalizedValue.includes('logical') ||
		normalizedValue.includes('preserve') ||
		normalizedValue.includes('readable')
	)
}

function normalizeJudgeSeverity(value: string): JudgeFinding['severity'] {
	const normalizedValue = value.trim().toLowerCase()
	if (normalizedValue.includes('high') || normalizedValue.includes('critical')) return 'high'
	if (normalizedValue.includes('med')) return 'medium'
	return 'low'
}

function normalizeLooseJudgeResult(
	input: z.infer<typeof LooseModelJudgeSchema>,
	judgeId: string
): JudgeResult {
	const normalizedScore = normalizeJudgeScore(parseNumberLikeValue(input.score))
	let normalizedConfidence = normalizeJudgeScore(parseNumberLikeValue(input.confidence))
	const normalizedFindingList = input.findings.map(finding => ({
		code: finding.code,
		details: finding.details,
		severity: normalizeJudgeSeverity(finding.severity)
	}))
	const hasHighSeverityFinding = normalizedFindingList.some(finding => finding.severity === 'high')
	const hasMediumSeverityFinding = normalizedFindingList.some(
		finding => finding.severity === 'medium'
	)
	const hasNegativeRationale = containsNegativeJudgmentSignal(input.rationale)
	const hasPositiveRationale = containsPositiveJudgmentSignal(input.rationale)
	let normalizedPassed = parseBooleanLikeValue(
		input.passed,
		normalizedScore >= 0.7 && !hasHighSeverityFinding
	)
	let effectiveScore = normalizedScore
	if (!hasHighSeverityFinding && !hasNegativeRationale) {
		if (
			!normalizedPassed &&
			(hasPositiveRationale ||
				normalizedFindingList.length === 0 ||
				normalizedFindingList.every(finding => finding.severity === 'low'))
		) {
			normalizedPassed = true
		}
		if (normalizedPassed && effectiveScore < 0.7) {
			effectiveScore = hasMediumSeverityFinding ? 0.72 : 0.85
		}
		if (normalizedPassed && normalizedConfidence === 0 && hasPositiveRationale) {
			normalizedConfidence = 0.8
		}
	}
	if (hasHighSeverityFinding && !hasPositiveRationale) {
		normalizedPassed = false
		effectiveScore = Math.min(effectiveScore, 0.35)
	}
	if (hasNegativeRationale && hasHighSeverityFinding) {
		normalizedPassed = false
	}
	return createJudgeResult({
		confidence: normalizedConfidence,
		findings: normalizedFindingList,
		judgeId,
		passed: normalizedPassed,
		rationale: input.rationale,
		score: effectiveScore
	})
}

function createFinding(
	code: string,
	details: string,
	severity: JudgeFinding['severity']
): JudgeFinding {
	return {
		code,
		details,
		severity
	}
}

function collectAppHeardText(observation: ScenarioObservation): string {
	if (observation.scenario.mode === 'chat') {
		const userTranscriptEventList = observation.testBusEventList
			.filter(isChatTranscriptEvent)
			.filter(event => event.role === 'user')
		const latestEvent = userTranscriptEventList[userTranscriptEventList.length - 1]
		return latestEvent?.text ?? ''
	}
	const translateEventList = observation.testBusEventList.filter(isTranslateCardEvent)
	const latestTranslateEvent = translateEventList[translateEventList.length - 1]
	return latestTranslateEvent?.sourceText ?? ''
}

function collectAssistantVisibleText(observation: ScenarioObservation): string {
	if (observation.scenario.mode === 'chat') {
		const assistantTranscriptEventList = observation.testBusEventList
			.filter(isChatTranscriptEvent)
			.filter(event => event.role === 'assistant')
		return assistantTranscriptEventList
			.map(event => event.text)
			.join('\n')
			.trim()
	}
	const translateEventList = observation.testBusEventList.filter(isTranslateCardEvent)
	const latestTranslateEvent = translateEventList[translateEventList.length - 1]
	return latestTranslateEvent?.targetText ?? ''
}

async function readLatestScreenshotPathList(screenshotDirectoryPath: string): Promise<string[]> {
	const directoryEntryList = await readdir(screenshotDirectoryPath, { withFileTypes: true })
	return directoryEntryList
		.filter(directoryEntry => directoryEntry.isFile() && directoryEntry.name.endsWith('.png'))
		.map(directoryEntry => join(screenshotDirectoryPath, directoryEntry.name))
		.sort()
		.slice(-3)
}

export async function runHardGuardrailJudge(
	observation: ScenarioObservation
): Promise<ScenarioJudgment> {
	const findingList: JudgeFinding[] = []
	const failureClusterReasonList: ScenarioJudgment['failureClusterReasonList'] = []
	const bodyText = observation.bodyText

	if (bodyText.includes(genericServerComponentErrorText)) {
		findingList.push(
			createFinding(
				'generic_server_component_error',
				'Generic Server Components error text was rendered in the UI.',
				'high'
			)
		)
	}

	for (const protocolPattern of trackedProtocolPatternList) {
		if (!protocolPattern.test(bodyText)) continue
		findingList.push(
			createFinding(
				'protocol_text_rendered',
				`User-visible protocol text matched ${protocolPattern.source}.`,
				'high'
			)
		)
	}

	for (const runtimeLogMatch of observation.runtimeLogMatchList) {
		findingList.push(
			createFinding('runtime_log_error', `Runtime log matched: ${runtimeLogMatch}`, 'high')
		)
	}

	for (const harnessFailure of observation.harnessFailureList) {
		findingList.push(
			createFinding('eval_harness_failure', `Scenario harness failed: ${harnessFailure}`, 'high')
		)
	}

	if (observation.errorTextList.length > 0) {
		for (const errorText of observation.errorTextList) {
			findingList.push(createFinding('visible_error_banner', errorText, 'medium'))
		}
	}

	switch (observation.scenario.mode) {
		case 'chat': {
			const userTranscriptEventList = observation.testBusEventList
				.filter(isChatTranscriptEvent)
				.filter(event => event.role === 'user')
			const assistantTranscriptEventList = observation.testBusEventList
				.filter(isChatTranscriptEvent)
				.filter(event => event.role === 'assistant')
			if (userTranscriptEventList.length === 0) {
				findingList.push(
					createFinding(
						'missing_user_transcript',
						'No user transcript was captured in chat mode.',
						'high'
					)
				)
			}
			if (assistantTranscriptEventList.length === 0) {
				findingList.push(
					createFinding(
						'missing_assistant_response',
						'No assistant response was captured in chat mode.',
						'high'
					)
				)
			}
			const firstUserEvent = userTranscriptEventList[0]
			const firstAssistantEvent = assistantTranscriptEventList[0]
			if (
				firstUserEvent &&
				firstAssistantEvent &&
				firstAssistantEvent.occurredAt < firstUserEvent.occurredAt
			) {
				findingList.push(
					createFinding(
						'chat_ordering_violation',
						'Assistant transcript arrived before the user transcript slot.',
						'high'
					)
				)
			}
			break
		}
		case 'translate': {
			const translateCardEventList = observation.testBusEventList.filter(isTranslateCardEvent)
			if (translateCardEventList.length === 0) {
				findingList.push(
					createFinding('missing_translate_card', 'No translate card patch was observed.', 'high')
				)
				break
			}
			const hasDraft = translateCardEventList.some(event => event.renderState === 'draft')
			const hasFinal = translateCardEventList.some(event => event.renderState === 'final')
			if (!hasDraft) {
				findingList.push(
					createFinding('missing_translate_draft', 'No draft translation state was observed.', 'medium')
				)
			}
			if (!hasFinal) {
				findingList.push(
					createFinding('missing_translate_final', 'No final translation state was observed.', 'high')
				)
			}
			break
		}
	}

	for (const [metricKey, maxLatencyMilliseconds] of Object.entries(
		observation.scenario.latencyBands
	)) {
		const observedLatency = observation.latencyMetrics[metricKey]
		if (typeof observedLatency !== 'number' || typeof maxLatencyMilliseconds !== 'number') continue
		if (observedLatency <= maxLatencyMilliseconds) continue
		findingList.push(
			createFinding(
				'latency_regression',
				`${metricKey} exceeded threshold (${observedLatency}ms > ${maxLatencyMilliseconds}ms).`,
				'medium'
			)
		)
	}

	if (findingList.length > 0) {
		failureClusterReasonList.push({
			reason: 'Deterministic guardrail failures were detected.',
			severity: 'high'
		})
	}

	const passed = findingList.every(finding => finding.severity !== 'high')
	const score = passed ? (findingList.length === 0 ? 1 : 0.75) : 0

	return {
		failureClusterReasonList,
		hardGateFindingList: findingList,
		judgeResultList: [
			createJudgeResult({
				confidence: 1,
				findings: findingList,
				judgeId: 'hard_guardrail_judge',
				passed,
				rationale: passed
					? 'Deterministic guardrails passed.'
					: 'Deterministic guardrails detected blocking issues.',
				score
			})
		]
	}
}

export async function runAudioInputReferenceJudge(
	observation: ScenarioObservation
): Promise<JudgeResult> {
	if (observation.scenario.inputType === 'text' || !observation.scenario.audioFixturePath) {
		return createJudgeResult({
			confidence: 1,
			findings: [],
			judgeId: 'audio_input_reference_judge',
			passed: true,
			rationale: 'Scenario does not use audio input.',
			score: 1
		})
	}
	const referenceTranscript = await transcribeAudioFile({
		audioFilePath: observation.scenario.audioFixturePath,
		model: 'gpt-4o-transcribe'
	})
	const expectedTranscript = observation.scenario.expectedUserTranscript ?? referenceTranscript
	const appHeardText = collectAppHeardText(observation)
	const referenceScore = computeTokenOverlapScore(expectedTranscript, referenceTranscript)
	const appScore = computeTokenOverlapScore(expectedTranscript, appHeardText)
	const passed = appScore >= 0.65
	const findingList: JudgeFinding[] = []
	if (!passed) {
		findingList.push(
			createFinding(
				'audio_input_mismatch',
				`App heard text diverged from expected transcript. expected="${expectedTranscript}" observed="${appHeardText}" reference="${referenceTranscript}"`,
				'medium'
			)
		)
	}
	return createJudgeResult({
		confidence: Math.max(referenceScore, 0.7),
		findings: findingList,
		judgeId: 'audio_input_reference_judge',
		passed,
		rationale: `Reference ASR similarity=${referenceScore.toFixed(2)}; app-heard similarity=${appScore.toFixed(2)}.`,
		score: Math.max(0, Math.min(1, (referenceScore + appScore) / 2))
	})
}

export async function runAudioOutputListenerJudge(
	observation: ScenarioObservation
): Promise<JudgeResult> {
	if (!observation.assistantAudioArtifactPath) {
		return createJudgeResult({
			confidence: 1,
			findings: [],
			judgeId: 'audio_output_listener_judge',
			passed: true,
			rationale: 'No assistant audio artifact was captured for this scenario.',
			score: 1
		})
	}

	const visibleAssistantText = collectAssistantVisibleText(observation)
	const base64Audio = await readAudioFileAsBase64(observation.assistantAudioArtifactPath)
	const result = await createChatCompletionJson({
		maxCompletionTokens: 700,
		messageList: [
			{
				content: [
					{
						text:
							'You are grading spoken assistant audio for an end-to-end app eval. Return JSON only with keys passed, score, confidence, rationale, findings. Score is 0 to 1. Findings is a list of {code, severity, details}. Judge whether the spoken audio is intelligible, matches the visible transcript, preserves the expected meaning, avoids repetition, and is not truncated.',
						type: 'text'
					}
				],
				role: 'system'
			},
			{
				content: [
					{
						text: `Expected meaning: ${observation.scenario.expectedAssistantMeaning ?? 'Not provided'}\nVisible transcript: ${visibleAssistantText || 'None'}\nJSON only.`,
						type: 'text'
					},
					{
						input_audio: {
							data: base64Audio,
							format: 'wav'
						},
						type: 'input_audio'
					}
				],
				role: 'user'
			}
		],
		model: 'gpt-audio-1.5',
		responseSchema: LooseModelJudgeSchema
	})
	return normalizeLooseJudgeResult(result, 'audio_output_listener_judge')
}

export async function runVisualUiJudge(observation: ScenarioObservation): Promise<JudgeResult> {
	const screenshotPathList = await readLatestScreenshotPathList(
		observation.artifactBundle.screenshotDirectoryPath
	)
	if (screenshotPathList.length === 0) {
		return createJudgeResult({
			confidence: 1,
			findings: [],
			judgeId: 'visual_ui_judge',
			passed: true,
			rationale: 'No screenshots were available for visual grading.',
			score: 1
		})
	}
	const contentList: Array<Record<string, unknown>> = [
		{
			text:
				'You are grading UI screenshots for a voice app. Return JSON only with keys passed, score, confidence, rationale, findings. Findings is a list of {code, severity, details}. Judge clipping, unreadable contrast, broken loading states, layout overflow, and whether the UI hierarchy is understandable for a consumer app.',
			type: 'text'
		}
	]
	for (const screenshotPath of screenshotPathList) {
		const base64Image = await readAudioFileAsBase64(screenshotPath)
		contentList.push({
			image_url: {
				url: `data:image/png;base64,${base64Image}`
			},
			type: 'image_url'
		})
	}
	contentList.push({
		text: `Visible DOM text excerpt:\n${observation.bodyText.slice(0, 4000)}\nJSON only.`,
		type: 'text'
	})
	const result = await createChatCompletionJson({
		maxCompletionTokens: 700,
		messageList: [
			{
				content: contentList,
				role: 'user'
			}
		],
		model: 'gpt-4.1',
		responseSchema: VisualUiJudgeSchema
	})
	return normalizeLooseJudgeResult(result, 'visual_ui_judge')
}

export async function runSemanticConversationJudge(
	observation: ScenarioObservation
): Promise<JudgeResult> {
	const appHeardText = collectAppHeardText(observation)
	const assistantVisibleText = collectAssistantVisibleText(observation)
	const promptText = [
		'You are grading whether the app preserved meaning and direction.',
		'Return JSON only with keys passed, score, confidence, rationale, findings.',
		'Findings is a list of {code, severity, details}.',
		`Mode: ${observation.scenario.mode}`,
		`Expected user transcript: ${observation.scenario.expectedUserTranscript ?? 'Not provided'}`,
		`Expected assistant meaning: ${observation.scenario.expectedAssistantMeaning ?? 'Not provided'}`,
		`Expected translation meaning: ${observation.scenario.expectedTranslationMeaning ?? 'Not provided'}`,
		`Observed user transcript/source: ${appHeardText || 'None'}`,
		`Observed assistant/translation text: ${assistantVisibleText || 'None'}`,
		'Judge semantic preservation, language direction, and conversational appropriateness.'
	].join('\n')
	const result = await createChatCompletionJson({
		maxCompletionTokens: 700,
		messageList: [
			{
				content: promptText,
				role: 'user'
			}
		],
		model: 'gpt-4.1',
		responseSchema: SemanticJudgeSchema
	})
	return normalizeLooseJudgeResult(result, 'semantic_conversation_judge')
}

export async function synthesizeRootCausePatchProposal(input: {
	candidateId: string
	failureClusterIdList: string[]
	observationList: ScenarioObservation[]
}): Promise<FlywheelPatchProposal> {
	const observationExcerptList = input.observationList.map(observation => ({
		assistantVisibleText: collectAssistantVisibleText(observation).slice(0, 500),
		bodyText: observation.bodyText.slice(0, 1200),
		errorTextList: observation.errorTextList,
		latencyMetrics: observation.latencyMetrics,
		runtimeLogMatchList: observation.runtimeLogMatchList,
		scenarioId: observation.scenario.id
	}))
	const result = await createResponsesJson({
		inputList: [
			{
				content: [
					{
						text:
							'You are Codex generating one bounded patch proposal for a failing voice-app eval run. Return JSON only with keys confidence, failureClusterIds, filePathList, prompt, reasoning, summary, allowlistedSurfaceList. The proposal must touch only allowlisted product surfaces such as prompts, model manifests, timing thresholds, reducer logic, realtime client state machines, smoke/eval instrumentation, or targeted UI fixes. Do not propose auth, billing, database, or broad dependency changes.',
						type: 'input_text'
					},
					{
						text: `Candidate ID: ${input.candidateId}\nFailure cluster IDs: ${JSON.stringify(input.failureClusterIdList)}\nObserved failures: ${JSON.stringify(observationExcerptList)}\nReturn JSON only.`,
						type: 'input_text'
					}
				],
				role: 'user'
			}
		],
		maxOutputTokens: 1200,
		model: 'gpt-5.3-codex',
		responseSchema: RootCauseSynthesisSchema
	})
	return FlywheelPatchProposalSchema.parse({
		allowlistedSurfaceList: result.allowlistedSurfaceList,
		confidence: result.confidence,
		failureClusterIds: result.failureClusterIds,
		filePathList: result.filePathList,
		prompt: result.prompt,
		summary: `${result.summary}\n\n${result.reasoning}`
	})
}

export function buildScenarioScorecard(input: {
	hardGateFindingList: JudgeFinding[]
	judgeResultList: JudgeResult[]
}): ReturnType<typeof EvalScorecardSchema.parse> {
	const aggregateScore =
		input.judgeResultList.reduce((scoreSum, judgeResult) => scoreSum + judgeResult.score, 0) /
		Math.max(1, input.judgeResultList.length)
	const hasHighSeverityHardGate = input.hardGateFindingList.some(
		finding => finding.severity === 'high'
	)
	const hasBlockingJudgeFinding = input.judgeResultList.some(judgeResult =>
		judgeResult.findings.some(finding => finding.severity === 'high')
	)
	const hasFailedJudge = input.judgeResultList.some(judgeResult => !judgeResult.passed)
	const releaseDecision = hasHighSeverityHardGate
		? 'block'
		: hasBlockingJudgeFinding || hasFailedJudge
			? 'block'
			: aggregateScore >= 0.92
				? 'promote'
				: aggregateScore >= 0.75
					? 'candidate'
					: 'block'
	return EvalScorecardSchema.parse({
		aggregateScore: Math.round(aggregateScore * 1000) / 1000,
		hardGateResults: input.hardGateFindingList,
		judgeResults: input.judgeResultList,
		regressionDeltas: {},
		releaseDecision
	})
}
