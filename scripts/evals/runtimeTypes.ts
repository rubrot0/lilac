import type {
	EvalArtifactBundle,
	EvalScenarioSpec,
	JudgeResult,
	LilacTestBusEvent
} from '@/evals/contracts'

export type ScenarioObservation = {
	artifactBundle: EvalArtifactBundle
	assistantAudioArtifactPath?: string
	bodyText: string
	browserConsoleEntryList: string[]
	domHtml: string
	errorTextList: string[]
	harnessFailureList: string[]
	latencyMetrics: Record<string, number>
	runtimeLogMatchList: string[]
	scenario: EvalScenarioSpec
	testBusEventList: LilacTestBusEvent[]
}

export type ScenarioJudgeContext = {
	observation: ScenarioObservation
}

export type ScenarioJudgment = {
	failureClusterReasonList: Array<{ reason: string; severity: 'high' | 'low' | 'medium' }>
	judgeResultList: JudgeResult[]
	hardGateFindingList: Array<{ code: string; details: string; severity: 'high' | 'low' | 'medium' }>
}
