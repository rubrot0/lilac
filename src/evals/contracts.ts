import { z } from 'zod'

import { LanguageCodeSchema } from '@/realtime/schemas'

export const EvalModeSchema = z.enum(['chat', 'translate'])
export type EvalMode = z.infer<typeof EvalModeSchema>

export const EvalInputTypeSchema = z.enum(['audio', 'mixed', 'text'])
export type EvalInputType = z.infer<typeof EvalInputTypeSchema>

export const EvalLatencyBandSchema = z.object({
	assistantAudioStartMs: z.number().int().nonnegative().optional(),
	assistantTextFirstMs: z.number().int().nonnegative().optional(),
	finalOutputMs: z.number().int().nonnegative().optional(),
	firstVisibleDraftMs: z.number().int().nonnegative().optional(),
	firstVisibleSourceMs: z.number().int().nonnegative().optional()
})
export type EvalLatencyBand = z.infer<typeof EvalLatencyBandSchema>

export const EvalLanguageExpectationSchema = z.object({
	inputLanguageCode: LanguageCodeSchema.optional(),
	outputLanguageCode: LanguageCodeSchema.optional(),
	pair: z
		.object({
			from: LanguageCodeSchema,
			to: LanguageCodeSchema
		})
		.optional()
})
export type EvalLanguageExpectation = z.infer<typeof EvalLanguageExpectationSchema>

export const EvalScenarioSpecSchema = z.object({
	audioFixturePath: z.string().min(1).optional(),
	expectedAssistantMeaning: z.string().min(1).optional(),
	expectedTranslationMeaning: z.string().min(1).optional(),
	expectedUiStates: z.array(z.string().min(1)).default([]),
	expectedUserTranscript: z.string().min(1).optional(),
	id: z.string().min(1),
	inputType: EvalInputTypeSchema,
	languageExpectation: EvalLanguageExpectationSchema.default({}),
	latencyBands: EvalLatencyBandSchema.default({}),
	mode: EvalModeSchema,
	promptText: z.string().min(1).optional(),
	targetViewport: z
		.object({
			height: z.number().int().positive(),
			width: z.number().int().positive()
		})
		.optional(),
	typedText: z.string().min(1).optional()
})
export type EvalScenarioSpec = z.infer<typeof EvalScenarioSpecSchema>

export const EvalArtifactBundleSchema = z.object({
	artifactDirectoryPath: z.string().min(1),
	assistantAudioArtifactPath: z.string().min(1).optional(),
	bodyTextPath: z.string().min(1).optional(),
	browserConsoleLogPath: z.string().min(1),
	clientTimelinePath: z.string().min(1),
	domSnapshotDirectoryPath: z.string().min(1),
	mode: EvalModeSchema,
	pageHtmlPath: z.string().min(1).optional(),
	rawTestBusPath: z.string().min(1).optional(),
	runtimeLogPath: z.string().min(1).optional(),
	runtimeStderrPath: z.string().min(1).optional(),
	scenarioId: z.string().min(1),
	screenshotDirectoryPath: z.string().min(1),
	targetUrl: z.string().url(),
	transcriptTimelinePath: z.string().min(1),
	translationTimelinePath: z.string().min(1)
})
export type EvalArtifactBundle = z.infer<typeof EvalArtifactBundleSchema>

export const JudgeFindingSchema = z.object({
	code: z.string().min(1),
	details: z.string().min(1),
	severity: z.enum(['high', 'low', 'medium'])
})
export type JudgeFinding = z.infer<typeof JudgeFindingSchema>

export const JudgeResultSchema = z.object({
	confidence: z.number().min(0).max(1),
	findings: z.array(JudgeFindingSchema).default([]),
	judgeId: z.string().min(1),
	passed: z.boolean(),
	rationale: z.string().min(1),
	score: z.number().min(0).max(1)
})
export type JudgeResult = z.infer<typeof JudgeResultSchema>

export const EvalScorecardSchema = z.object({
	aggregateScore: z.number().min(0).max(1),
	hardGateResults: z.array(JudgeFindingSchema).default([]),
	judgeResults: z.array(JudgeResultSchema),
	regressionDeltas: z.record(z.string(), z.number()),
	releaseDecision: z.enum(['block', 'candidate', 'promote', 'rollback'])
})
export type EvalScorecard = z.infer<typeof EvalScorecardSchema>

export const EvalCandidateConfigSchema = z.object({
	asrModelSlug: z.string().min(1),
	buildEnvironmentOverrides: z.record(z.string(), z.string()).default({}),
	chatTurnOrderingProfile: z.string().min(1).default('default'),
	draftDebounceMilliseconds: z.number().int().positive().optional(),
	featureFlags: z.record(z.string(), z.boolean()).default({}),
	id: z.string().min(1),
	label: z.string().min(1),
	promptVersionIds: z.record(z.string(), z.string()).default({}),
	realtimeModelSlug: z.string().min(1),
	translateCommitIntervalMilliseconds: z.number().int().positive().optional(),
	translateLanguageGroundingMode: z.string().min(1).default('pair_locked'),
	translateMinimumCommitAudioMilliseconds: z.number().int().positive().optional()
})
export type EvalCandidateConfig = z.infer<typeof EvalCandidateConfigSchema>

export const EvalMatrixSchema = z.object({
	baseline: EvalCandidateConfigSchema,
	candidateList: z.array(EvalCandidateConfigSchema).default([]),
	id: z.string().min(1),
	version: z.number().int().positive()
})
export type EvalMatrix = z.infer<typeof EvalMatrixSchema>

export const FailureClusterSchema = z.object({
	clusterId: z.string().min(1),
	reason: z.string().min(1),
	scenarioIds: z.array(z.string().min(1)).default([]),
	severity: z.enum(['high', 'low', 'medium'])
})
export type FailureCluster = z.infer<typeof FailureClusterSchema>

export const FlywheelPatchProposalSchema = z.object({
	allowlistedSurfaceList: z.array(z.string().min(1)).min(1),
	confidence: z.number().min(0).max(1),
	failureClusterIds: z.array(z.string().min(1)).min(1),
	filePathList: z.array(z.string().min(1)).default([]),
	prompt: z.string().min(1),
	summary: z.string().min(1)
})
export type FlywheelPatchProposal = z.infer<typeof FlywheelPatchProposalSchema>

export const FlywheelDecisionSchema = z.object({
	action: z.enum([
		'block',
		'deploy_preview',
		'promote_to_production',
		'propose_patch',
		'report_only',
		'rollback'
	]),
	candidateId: z.string().min(1).optional(),
	patchProposal: FlywheelPatchProposalSchema.optional(),
	reasons: z.array(z.string().min(1)).min(1)
})
export type FlywheelDecision = z.infer<typeof FlywheelDecisionSchema>

const LilacTestBusBaseEventSchema = z.object({
	eventId: z.string().min(1),
	occurredAt: z.number().int().nonnegative()
})

const LilacModeChangedEventSchema = LilacTestBusBaseEventSchema.extend({
	eventType: z.literal('mode_changed'),
	mode: EvalModeSchema
})

const LilacConnectionStateEventSchema = LilacTestBusBaseEventSchema.extend({
	connectionState: z.enum(['connected', 'connecting', 'error', 'idle']),
	eventType: z.literal('connection_state_changed'),
	statusMessage: z.string().nullable()
})

const LilacChatTranscriptEventSchema = LilacTestBusBaseEventSchema.extend({
	eventType: z.literal('chat_transcript_patch'),
	messageId: z.string().min(1),
	role: z.enum(['assistant', 'user']),
	source: z.enum([
		'input_transcription',
		'input_text',
		'response_output_audio_transcript',
		'response_output_text'
	]),
	status: z.enum(['final', 'streaming']),
	text: z.string()
})

const LilacTranslateCardEventSchema = LilacTestBusBaseEventSchema.extend({
	cardId: z.string().min(1),
	direction: z.enum(['my_to_target', 'target_to_my']),
	eventType: z.literal('translate_card_patch'),
	renderState: z.enum(['draft', 'error', 'final', 'listening']),
	sourceText: z.string(),
	targetText: z.string()
})

const LilacSubtitleStateEventSchema = LilacTestBusBaseEventSchema.extend({
	activeSegmentId: z.string().nullable(),
	eventType: z.literal('subtitle_state_changed'),
	isListening: z.boolean(),
	text: z.string()
})

const LilacAssistantAudioStateEventSchema = LilacTestBusBaseEventSchema.extend({
	eventType: z.literal('assistant_audio_state_changed'),
	isPlaying: z.boolean()
})

const LilacVisibleErrorEventSchema = LilacTestBusBaseEventSchema.extend({
	errorMessage: z.string().nullable(),
	eventType: z.literal('visible_error_changed')
})

export const LilacTestBusEventSchema = z.discriminatedUnion('eventType', [
	LilacModeChangedEventSchema,
	LilacConnectionStateEventSchema,
	LilacChatTranscriptEventSchema,
	LilacTranslateCardEventSchema,
	LilacSubtitleStateEventSchema,
	LilacAssistantAudioStateEventSchema,
	LilacVisibleErrorEventSchema
])
export type LilacTestBusEvent = z.infer<typeof LilacTestBusEventSchema>

export const EvalScenarioRunSummarySchema = z.object({
	artifactBundle: EvalArtifactBundleSchema,
	latencyMetrics: z.record(z.string(), z.number()),
	scenario: EvalScenarioSpecSchema,
	scorecard: EvalScorecardSchema
})
export type EvalScenarioRunSummary = z.infer<typeof EvalScenarioRunSummarySchema>

export const EvalRunSummarySchema = z.object({
	appCommitSha: z.string().min(1),
	artifactDirectoryPath: z.string().min(1),
	candidateConfig: EvalCandidateConfigSchema,
	deployedUrl: z.string().url(),
	evaluationId: z.string().min(1),
	failureClusterList: z.array(FailureClusterSchema).default([]),
	scenarioRunSummaryList: z.array(EvalScenarioRunSummarySchema),
	scorecard: EvalScorecardSchema,
	startedAtIso: z.string().min(1)
})
export type EvalRunSummary = z.infer<typeof EvalRunSummarySchema>

export function createLilacTestBusEventId(): string {
	return crypto.randomUUID()
}
