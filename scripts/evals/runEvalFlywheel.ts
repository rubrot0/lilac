import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type {
	EvalCandidateConfig,
	EvalRunSummary,
	FlywheelDecision,
	FlywheelPatchProposal
} from '@/evals/contracts'
import { FlywheelDecisionSchema } from '@/evals/contracts'
import { synthesizeRootCausePatchProposal } from './judges'
import {
	type EvalRunExecution,
	executeEvalSuite,
	loadEvalMatrix,
	selectCandidateConfig
} from './runEvalSuite'

type ParsedFlywheelArguments = {
	baselineUrl: string
	candidateId: string
	candidateUrl?: string
	captureVercelLogs: boolean
	evaluationId?: string
	matrixPath: string
	scenarioIdList?: string[]
}

type CandidateComparison = {
	candidateBeatsBaseline: boolean
	hasLowConfidenceBlockingJudge: boolean
	protectedRegressionList: string[]
	regressionDeltas: Record<string, number>
	reasonList: string[]
}

type FlywheelState = z.infer<typeof FlywheelStateSchema>

type VercelCommandResult = {
	outputText: string
	url?: string
	urlList: string[]
}

const highSignalCanaryScenarioIdList = [
	'chat_audio_practice_ukrainian',
	'translate_audio_en_to_es',
	'translate_audio_en_long_to_es',
	'translate_audio_en_noisy_fillers_to_es'
] as const
const flywheelStatePath = resolve(process.cwd(), '.artifacts/evals/flywheel-state.json')
const flywheelPatchPromptPath = resolve(process.cwd(), '.artifacts/evals/latest-patch-proposal.md')
const flywheelPatchProposalPath = resolve(
	process.cwd(),
	'.artifacts/evals/latest-patch-proposal.json'
)

const FlywheelStateSchema = z.object({
	dateKey: z.string().min(1),
	estimatedCostUsd: z.number().min(0),
	failureAttemptCountByClusterKey: z.record(z.string(), z.number().int().nonnegative()),
	lastGoodProductionDeploymentUrl: z.string().url().optional(),
	runCount: z.number().int().nonnegative()
})

function parseArguments(argumentList: string[]): ParsedFlywheelArguments {
	const parsedArguments: ParsedFlywheelArguments = {
		baselineUrl: 'https://lilac.chat',
		candidateId: 'workspace-preview',
		captureVercelLogs: true,
		matrixPath: resolve(process.cwd(), 'scripts/evals/manifests/default.matrix.json')
	}

	for (let argumentIndex = 0; argumentIndex < argumentList.length; argumentIndex += 1) {
		const argument = argumentList[argumentIndex]
		switch (argument) {
			case '--baseline-url': {
				parsedArguments.baselineUrl = argumentList[argumentIndex + 1] ?? parsedArguments.baselineUrl
				argumentIndex += 1
				break
			}
			case '--candidate-id': {
				parsedArguments.candidateId = argumentList[argumentIndex + 1] ?? parsedArguments.candidateId
				argumentIndex += 1
				break
			}
			case '--candidate-url': {
				const candidateUrl = argumentList[argumentIndex + 1]
				if (candidateUrl) {
					parsedArguments.candidateUrl = candidateUrl
				}
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
				parsedArguments.scenarioIdList = (argumentList[argumentIndex + 1] ?? '')
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
			default:
				break
		}
	}

	return parsedArguments
}

function createTimestampLabel(): string {
	return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

function createEvaluationId(prefix: string): string {
	return `${prefix}-${createTimestampLabel()}`
}

function resolveBooleanEnvironmentFlag(name: string, fallbackValue: boolean): boolean {
	const rawValue = process.env[name]?.trim().toLowerCase()
	if (rawValue === 'true') return true
	if (rawValue === 'false') return false
	return fallbackValue
}

function resolvePositiveIntegerEnvironmentValue(name: string, fallbackValue: number): number {
	const rawValue = process.env[name]?.trim()
	if (!rawValue) return fallbackValue
	const parsedValue = Number.parseInt(rawValue, 10)
	return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue
}

function resolvePositiveNumberEnvironmentValue(name: string, fallbackValue: number): number {
	const rawValue = process.env[name]?.trim()
	if (!rawValue) return fallbackValue
	const parsedValue = Number.parseFloat(rawValue)
	return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue
}

function toEnvironmentVariableName(flagId: string): string {
	return `NEXT_PUBLIC_${flagId.replaceAll(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`
}

function buildCandidateEnvironmentOverrides(
	candidateConfig: EvalCandidateConfig
): Record<string, string> {
	const environmentOverrides: Record<string, string> = {
		...candidateConfig.buildEnvironmentOverrides,
		NEXT_PUBLIC_LILAC_CHAT_TURN_ORDERING_PROFILE: candidateConfig.chatTurnOrderingProfile,
		NEXT_PUBLIC_LILAC_REALTIME_MODEL: candidateConfig.realtimeModelSlug,
		NEXT_PUBLIC_LILAC_TRANSCRIPTION_MODEL: candidateConfig.asrModelSlug,
		NEXT_PUBLIC_LILAC_TRANSLATE_LANGUAGE_GROUNDING_MODE:
			candidateConfig.translateLanguageGroundingMode,
		NEXT_PUBLIC_LILAC_TRANSLATE_PROMPT_VERSION:
			candidateConfig.promptVersionIds.translate ?? 'current'
	}
	if (candidateConfig.asrModelSlug === 'gpt-4o-mini-transcribe') {
		environmentOverrides.NEXT_PUBLIC_LILAC_TRANSCRIBE_ASR_PROFILE = 'fast'
	} else {
		environmentOverrides.NEXT_PUBLIC_LILAC_TRANSCRIBE_ASR_PROFILE = 'accurate'
	}
	if (typeof candidateConfig.draftDebounceMilliseconds === 'number') {
		environmentOverrides.NEXT_PUBLIC_LILAC_TRANSLATE_DRAFT_DEBOUNCE_MS = String(
			candidateConfig.draftDebounceMilliseconds
		)
	}
	if (typeof candidateConfig.translateCommitIntervalMilliseconds === 'number') {
		environmentOverrides.NEXT_PUBLIC_LILAC_TRANSLATE_COMMIT_INTERVAL_MS = String(
			candidateConfig.translateCommitIntervalMilliseconds
		)
	}
	if (typeof candidateConfig.translateMinimumCommitAudioMilliseconds === 'number') {
		environmentOverrides.NEXT_PUBLIC_LILAC_TRANSLATE_MIN_COMMIT_AUDIO_MS = String(
			candidateConfig.translateMinimumCommitAudioMilliseconds
		)
	}
	for (const [featureFlagId, featureFlagValue] of Object.entries(candidateConfig.featureFlags)) {
		environmentOverrides[toEnvironmentVariableName(featureFlagId)] = String(featureFlagValue)
	}
	return environmentOverrides
}

function extractUrlList(outputText: string): string[] {
	return Array.from(outputText.matchAll(/https:\/\/[\w.-]+\.vercel\.app/g)).map(match => match[0])
}

function executeVercelCommand(argumentList: string[]): VercelCommandResult {
	const result = spawnSync('vercel', argumentList, {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: process.env
	})
	const outputText = [result.stdout, result.stderr].filter(Boolean).join('\n')
	if (result.status !== 0) {
		throw new Error(outputText || `Vercel command failed: vercel ${argumentList.join(' ')}`)
	}
	const urlList = extractUrlList(outputText)
	return {
		outputText,
		...(urlList.length > 0 ? { url: urlList[urlList.length - 1] } : {}),
		urlList
	}
}

function buildVercelEnvironmentArgumentList(
	environmentOverrides: Record<string, string>
): string[] {
	const argumentList: string[] = []
	for (const [key, value] of Object.entries(environmentOverrides)) {
		argumentList.push('--build-env', `${key}=${value}`, '--env', `${key}=${value}`)
	}
	return argumentList
}

function slugifyAliasSegment(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48)
}

function resolvePublicPreviewAliasHost(candidateConfig: EvalCandidateConfig): string | null {
	const explicitUrl = process.env.LILAC_EVAL_PREVIEW_URL?.trim()
	if (explicitUrl) {
		try {
			return new URL(explicitUrl).host
		} catch {
			return explicitUrl.replace(/^https?:\/\//, '')
		}
	}
	const aliasDomain = process.env.LILAC_EVAL_PREVIEW_ALIAS_DOMAIN?.trim()
	if (!aliasDomain) return null
	const aliasPrefix = slugifyAliasSegment(candidateConfig.id || candidateConfig.label)
	if (!aliasPrefix) return null
	return `${aliasPrefix}.${aliasDomain}`
}

function deployPreview(candidateConfig: EvalCandidateConfig): string {
	const environmentOverrides = buildCandidateEnvironmentOverrides(candidateConfig)
	const deploymentResult = executeVercelCommand([
		'deploy',
		'--yes',
		'--force',
		'--public',
		'--target',
		'preview',
		'--meta',
		`lilac_eval_candidate_id=${candidateConfig.id}`,
		'--meta',
		`lilac_eval_candidate_label=${candidateConfig.label}`,
		...buildVercelEnvironmentArgumentList(environmentOverrides)
	])
	if (!deploymentResult.url) {
		throw new Error('Preview deployment completed without a deployment URL.')
	}
	const publicPreviewAliasHost = resolvePublicPreviewAliasHost(candidateConfig)
	if (!publicPreviewAliasHost) return deploymentResult.url
	executeVercelCommand(['alias', 'set', deploymentResult.url, publicPreviewAliasHost])
	return `https://${publicPreviewAliasHost}`
}

function promoteDeployment(deploymentUrl: string): void {
	executeVercelCommand(['promote', deploymentUrl, '--yes'])
}

function rollbackDeployment(deploymentUrl: string): void {
	executeVercelCommand(['rollback', deploymentUrl, '--yes'])
}

function getCurrentProductionDeploymentUrl(): string | undefined {
	const deploymentResult = executeVercelCommand(['list', '--environment', 'production', 'lilac'])
	return deploymentResult.url
}

async function loadFlywheelState(): Promise<FlywheelState> {
	try {
		const stateContent = await readFile(flywheelStatePath, 'utf8')
		const parsedState = FlywheelStateSchema.parse(JSON.parse(stateContent))
		const currentDateKey = new Date().toISOString().slice(0, 10)
		if (parsedState.dateKey === currentDateKey) return parsedState
	} catch {}
	return FlywheelStateSchema.parse({
		dateKey: new Date().toISOString().slice(0, 10),
		estimatedCostUsd: 0,
		failureAttemptCountByClusterKey: {},
		runCount: 0
	})
}

async function writeFlywheelState(state: FlywheelState): Promise<void> {
	await mkdir(dirname(flywheelStatePath), { recursive: true })
	await writeFile(flywheelStatePath, JSON.stringify(state, null, 2), 'utf8')
}

function estimateEvalRunCostUsd(execution: EvalRunExecution): number {
	const scenarioCount = execution.runSummary.scenarioRunSummaryList.length
	const audioScenarioCount = execution.runSummary.scenarioRunSummaryList.filter(summary => {
		return summary.scenario.inputType !== 'text'
	}).length
	const screenshotWeight = execution.runSummary.scenarioRunSummaryList.length * 0.03
	return (
		Math.round((scenarioCount * 0.18 + audioScenarioCount * 0.12 + screenshotWeight) * 100) / 100
	)
}

function compareRuns(
	baselineSummary: EvalRunSummary,
	candidateSummary: EvalRunSummary
): CandidateComparison {
	const regressionDeltas: Record<string, number> = {
		aggregateScore:
			Math.round(
				(candidateSummary.scorecard.aggregateScore - baselineSummary.scorecard.aggregateScore) * 1000
			) / 1000
	}
	const protectedRegressionList: string[] = []
	const reasonList: string[] = []

	const baselineScenarioSummaryById = new Map(
		baselineSummary.scenarioRunSummaryList.map(scenarioSummary => [
			scenarioSummary.scenario.id,
			scenarioSummary
		])
	)
	for (const candidateScenarioSummary of candidateSummary.scenarioRunSummaryList) {
		const baselineScenarioSummary = baselineScenarioSummaryById.get(
			candidateScenarioSummary.scenario.id
		)
		if (!baselineScenarioSummary) continue
		const scoreDelta =
			candidateScenarioSummary.scorecard.aggregateScore -
			baselineScenarioSummary.scorecard.aggregateScore
		regressionDeltas[candidateScenarioSummary.scenario.id] = Math.round(scoreDelta * 1000) / 1000
		if (scoreDelta < -0.05) {
			protectedRegressionList.push(
				`Scenario ${candidateScenarioSummary.scenario.id} regressed by ${Math.abs(scoreDelta).toFixed(3)}.`
			)
		}
		if (
			candidateScenarioSummary.scorecard.releaseDecision === 'block' &&
			baselineScenarioSummary.scorecard.releaseDecision !== 'block'
		) {
			protectedRegressionList.push(
				`Scenario ${candidateScenarioSummary.scenario.id} became blocking in the candidate run.`
			)
		}
	}

	const baselineHighSeverityCount = baselineSummary.scorecard.hardGateResults.filter(
		finding => finding.severity === 'high'
	).length
	const candidateHighSeverityCount = candidateSummary.scorecard.hardGateResults.filter(
		finding => finding.severity === 'high'
	).length
	regressionDeltas.hardGateHighSeverity = candidateHighSeverityCount - baselineHighSeverityCount
	if (candidateHighSeverityCount > baselineHighSeverityCount) {
		protectedRegressionList.push('Candidate introduced additional high-severity hard-gate findings.')
	}

	const hasLowConfidenceBlockingJudge =
		candidateSummary.scorecard.releaseDecision === 'block' &&
		(candidateSummary.scorecard.judgeResults.some(judgeResult => {
			return !judgeResult.passed && judgeResult.confidence < 0.6
		}) ||
			false)
	if (hasLowConfidenceBlockingJudge) {
		protectedRegressionList.push('Blocking candidate failures include low-confidence judge outputs.')
	}

	reasonList.push(
		`Baseline aggregate score=${baselineSummary.scorecard.aggregateScore.toFixed(3)}.`,
		`Candidate aggregate score=${candidateSummary.scorecard.aggregateScore.toFixed(3)}.`
	)

	const candidateBeatsBaseline =
		candidateSummary.scorecard.releaseDecision !== 'block' &&
		candidateSummary.scorecard.aggregateScore > baselineSummary.scorecard.aggregateScore &&
		protectedRegressionList.length === 0
	if (!candidateBeatsBaseline) {
		reasonList.push('Candidate did not strictly beat the baseline under protected metrics.')
	}

	return {
		candidateBeatsBaseline,
		hasLowConfidenceBlockingJudge,
		protectedRegressionList,
		reasonList,
		regressionDeltas
	}
}

function buildFailureClusterKey(summary: EvalRunSummary): string {
	const clusterIdList = summary.failureClusterList.map(cluster => cluster.clusterId).sort()
	return clusterIdList.join('|') || 'no-failure-clusters'
}

function createFlywheelDecision(input: FlywheelDecision): FlywheelDecision {
	return FlywheelDecisionSchema.parse(input)
}

async function maybeRunPatchCommand(input: {
	patchProposal: FlywheelPatchProposal
	state: FlywheelState
	summary: EvalRunSummary
}): Promise<{ commandRan: boolean; commandSucceeded: boolean }> {
	const patchCommand = process.env.LILAC_FLYWHEEL_PATCH_COMMAND?.trim()
	if (!patchCommand) return { commandRan: false, commandSucceeded: false }

	await mkdir(dirname(flywheelPatchPromptPath), { recursive: true })
	await writeFile(flywheelPatchProposalPath, JSON.stringify(input.patchProposal, null, 2), 'utf8')
	await writeFile(
		flywheelPatchPromptPath,
		[
			`Candidate: ${input.summary.candidateConfig.id}`,
			`Evaluation: ${input.summary.evaluationId}`,
			`Failure clusters: ${input.patchProposal.failureClusterIds.join(', ')}`,
			'',
			input.patchProposal.summary,
			'',
			input.patchProposal.prompt
		].join('\n'),
		'utf8'
	)

	const commandResult = spawnSync('zsh', ['-lc', patchCommand], {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: {
			...process.env,
			LILAC_FLYWHEEL_EVALUATION_ID: input.summary.evaluationId,
			LILAC_FLYWHEEL_PATCH_PROMPT_PATH: flywheelPatchPromptPath,
			LILAC_FLYWHEEL_PATCH_PROPOSAL_PATH: flywheelPatchProposalPath
		},
		stdio: 'inherit'
	})
	return {
		commandRan: true,
		commandSucceeded: commandResult.status === 0
	}
}

async function evaluateCandidateAgainstPreview(input: {
	candidateConfig: EvalCandidateConfig
	captureVercelLogs: boolean
	deploymentUrl: string
	evaluationIdPrefix: string
	scenarioIdList?: string[]
}): Promise<EvalRunExecution> {
	return executeEvalSuite({
		candidateConfig: input.candidateConfig,
		captureVercelLogs: input.captureVercelLogs,
		evaluationId: createEvaluationId(input.evaluationIdPrefix),
		targetUrl: input.deploymentUrl,
		...(input.scenarioIdList ? { scenarioIdList: input.scenarioIdList } : {})
	})
}

async function main(): Promise<void> {
	const parsedArguments = parseArguments(process.argv.slice(2))
	const evalMatrix = await loadEvalMatrix(parsedArguments.matrixPath)
	const baselineConfig = evalMatrix.baseline
	const candidateConfig = selectCandidateConfig(
		[evalMatrix.baseline, ...evalMatrix.candidateList],
		parsedArguments.candidateId
	)
	const flywheelEnabled = resolveBooleanEnvironmentFlag('LILAC_FLYWHEEL_ENABLED', true)
	const autoprodEnabled = resolveBooleanEnvironmentFlag('LILAC_FLYWHEEL_AUTOPROD_ENABLED', false)
	const maxRunsPerDay = resolvePositiveIntegerEnvironmentValue('LILAC_FLYWHEEL_MAX_RUNS_PER_DAY', 8)
	const maxPatchAttemptsPerFailure = resolvePositiveIntegerEnvironmentValue(
		'LILAC_FLYWHEEL_MAX_PATCH_ATTEMPTS_PER_FAILURE',
		1
	)
	const budgetLimitUsd = resolvePositiveNumberEnvironmentValue('LILAC_FLYWHEEL_BUDGET_USD_LIMIT', 25)
	const flywheelState = await loadFlywheelState()
	if (flywheelState.runCount >= maxRunsPerDay) {
		throw new Error(`Flywheel max runs per day exceeded (${maxRunsPerDay}).`)
	}

	const flywheelArtifactDirectoryPath = resolve(
		process.cwd(),
		'.artifacts/evals/flywheel',
		parsedArguments.evaluationId ?? createEvaluationId('flywheel')
	)
	await mkdir(flywheelArtifactDirectoryPath, { recursive: true })

	const baselineExecution = await executeEvalSuite({
		candidateConfig: baselineConfig,
		captureVercelLogs: parsedArguments.captureVercelLogs,
		evaluationId: createEvaluationId('baseline'),
		targetUrl: parsedArguments.baselineUrl,
		...(parsedArguments.scenarioIdList ? { scenarioIdList: parsedArguments.scenarioIdList } : {})
	})
	const baselineCostEstimate = estimateEvalRunCostUsd(baselineExecution)
	flywheelState.runCount += 1
	flywheelState.estimatedCostUsd += baselineCostEstimate

	if (flywheelState.estimatedCostUsd > budgetLimitUsd) {
		await writeFlywheelState(flywheelState)
		throw new Error(
			`Flywheel estimated budget exceeded (${flywheelState.estimatedCostUsd.toFixed(2)} > ${budgetLimitUsd}).`
		)
	}

	const previewDeploymentUrl = parsedArguments.candidateUrl
		? parsedArguments.candidateUrl
		: candidateConfig.id === baselineConfig.id
			? parsedArguments.baselineUrl
			: flywheelEnabled
				? deployPreview(candidateConfig)
				: undefined
	if (!previewDeploymentUrl) {
		await writeFlywheelState(flywheelState)
		throw new Error('Candidate URL is required when flywheel deployment is disabled.')
	}

	const candidateExecution = await evaluateCandidateAgainstPreview({
		candidateConfig,
		captureVercelLogs: parsedArguments.captureVercelLogs,
		deploymentUrl: previewDeploymentUrl,
		evaluationIdPrefix: 'candidate-01',
		...(parsedArguments.scenarioIdList ? { scenarioIdList: parsedArguments.scenarioIdList } : {})
	})
	flywheelState.runCount += 1
	flywheelState.estimatedCostUsd += estimateEvalRunCostUsd(candidateExecution)
	const candidateComparison = compareRuns(
		baselineExecution.runSummary,
		candidateExecution.runSummary
	)
	const failureClusterKey = buildFailureClusterKey(candidateExecution.runSummary)
	const failureAttemptCount = flywheelState.failureAttemptCountByClusterKey[failureClusterKey] ?? 0

	const decisionReasonList = [...candidateComparison.reasonList]
	let finalDecision = createFlywheelDecision({
		action: 'report_only',
		candidateId: candidateConfig.id,
		reasons: ['Flywheel evaluation completed.']
	})
	let verificationExecution: EvalRunExecution | null = null
	let canaryExecution: EvalRunExecution | null = null
	let patchProposal: FlywheelPatchProposal | null = null
	let previousProductionDeploymentUrl: string | undefined
	let patchCommandResult = { commandRan: false, commandSucceeded: false }

	if (!candidateComparison.candidateBeatsBaseline) {
		decisionReasonList.push(...candidateComparison.protectedRegressionList)
		patchProposal = await synthesizeRootCausePatchProposal({
			candidateId: candidateConfig.id,
			failureClusterIdList: candidateExecution.runSummary.failureClusterList.map(
				cluster => cluster.clusterId
			),
			observationList: candidateExecution.observationList
		})
		finalDecision = createFlywheelDecision({
			action: 'propose_patch',
			candidateId: candidateConfig.id,
			patchProposal,
			reasons:
				decisionReasonList.length > 0 ? decisionReasonList : ['Candidate did not beat baseline.']
		})
		if (failureAttemptCount < maxPatchAttemptsPerFailure) {
			patchCommandResult = await maybeRunPatchCommand({
				patchProposal,
				state: flywheelState,
				summary: candidateExecution.runSummary
			})
			flywheelState.failureAttemptCountByClusterKey[failureClusterKey] = failureAttemptCount + 1
		}
	} else {
		verificationExecution = await evaluateCandidateAgainstPreview({
			candidateConfig,
			captureVercelLogs: parsedArguments.captureVercelLogs,
			deploymentUrl: previewDeploymentUrl,
			evaluationIdPrefix: 'candidate-02',
			...(parsedArguments.scenarioIdList ? { scenarioIdList: parsedArguments.scenarioIdList } : {})
		})
		flywheelState.runCount += 1
		flywheelState.estimatedCostUsd += estimateEvalRunCostUsd(verificationExecution)
		const verificationComparison = compareRuns(
			baselineExecution.runSummary,
			verificationExecution.runSummary
		)
		if (!verificationComparison.candidateBeatsBaseline) {
			decisionReasonList.push(
				'Candidate passed once but failed the required second verification run.',
				...verificationComparison.protectedRegressionList
			)
			finalDecision = createFlywheelDecision({
				action: 'block',
				candidateId: candidateConfig.id,
				reasons: decisionReasonList
			})
		} else if (!autoprodEnabled || !flywheelEnabled) {
			decisionReasonList.push(
				'Preview passed twice. Autoprod is disabled, so the run stops at candidate status.'
			)
			finalDecision = createFlywheelDecision({
				action: 'deploy_preview',
				candidateId: candidateConfig.id,
				reasons: decisionReasonList
			})
		} else {
			previousProductionDeploymentUrl = getCurrentProductionDeploymentUrl()
			promoteDeployment(previewDeploymentUrl)
			canaryExecution = await executeEvalSuite({
				candidateConfig,
				captureVercelLogs: parsedArguments.captureVercelLogs,
				evaluationId: createEvaluationId('prod-canary'),
				scenarioIdList: [...highSignalCanaryScenarioIdList],
				targetUrl: parsedArguments.baselineUrl
			})
			flywheelState.runCount += 1
			flywheelState.estimatedCostUsd += estimateEvalRunCostUsd(canaryExecution)
			const canaryComparison = compareRuns(baselineExecution.runSummary, canaryExecution.runSummary)
			if (!canaryComparison.candidateBeatsBaseline) {
				rollbackDeployment(previewDeploymentUrl)
				decisionReasonList.push(
					'Production canary regressed after promotion. Rollback was triggered.',
					...canaryComparison.protectedRegressionList
				)
				finalDecision = createFlywheelDecision({
					action: 'rollback',
					candidateId: candidateConfig.id,
					reasons: decisionReasonList
				})
			} else {
				flywheelState.lastGoodProductionDeploymentUrl = previewDeploymentUrl
				decisionReasonList.push('Preview passed twice and production canary passed.')
				finalDecision = createFlywheelDecision({
					action: 'promote_to_production',
					candidateId: candidateConfig.id,
					reasons: decisionReasonList
				})
			}
		}
	}

	const summary = {
		autoprodEnabled,
		baseline: baselineExecution.runSummary,
		budgetLimitUsd,
		candidate: candidateExecution.runSummary,
		candidateComparison,
		candidateDeploymentUrl: previewDeploymentUrl,
		decision: finalDecision,
		flywheelEnabled,
		patchCommandResult,
		...(patchProposal ? { patchProposal } : {}),
		...(previousProductionDeploymentUrl ? { previousProductionDeploymentUrl } : {}),
		state: flywheelState,
		...(verificationExecution ? { verification: verificationExecution.runSummary } : {}),
		...(canaryExecution ? { productionCanary: canaryExecution.runSummary } : {})
	}
	await writeFile(
		join(flywheelArtifactDirectoryPath, 'flywheel-summary.json'),
		JSON.stringify(summary, null, 2),
		'utf8'
	)
	await writeFlywheelState(flywheelState)
	console.log(JSON.stringify(summary, null, 2))

	if (finalDecision.action === 'block' || finalDecision.action === 'rollback') {
		throw new Error(finalDecision.reasons.join(' '))
	}
}

void main().catch(error => {
	console.error(error instanceof Error ? error.message : 'Eval flywheel failed.')
	process.exit(1)
})
