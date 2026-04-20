/**
 * @format
 * Interview Coach Agent — Stage-Specific Preparation
 *
 * Third and final agent in the strategist pipeline. Receives the
 * Strategist Agent's full XML analysis and produces targeted
 * interview preparation for the current stage.
 *
 * Uses Haiku 4.5 — fast and conversational, optimised for
 * structured coaching output.
 *
 * Pipeline position: API → Research → Strategist → **Coach** → DynamoDB
 */

import { BaseAgent, parseJsonResponse, log } from '../../../shared/src/index.js';
import { COACH_PERSONA_SYSTEM_PROMPT } from '../prompts/coach-persona.js';
import type {
    AgentConfig,
    AgentResult,
    StrategistPipelineContext,
    StrategistAnalysisResult,
    InterviewCoachResult,
} from '../../../shared/src/index.js';

// =============================================================================
// INPUT TYPE
// =============================================================================

/**
 * Typed input for the Interview Coach Agent.
 *
 * Contains the Strategist Agent's full XML analysis output.
 */
export interface CoachAgentInput {
    /** Strategist Agent's analysis containing the full XML */
    readonly analysis: StrategistAnalysisResult;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Coach model — Haiku 4.5 for fast, conversational output */
const COACH_MODEL = process.env.COACH_MODEL ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? COACH_MODEL;

/** Maximum output tokens */
const COACH_MAX_TOKENS = 8192;

/** Thinking budget for coaching preparation */
const COACH_THINKING_BUDGET = 4096;

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Interview Coach Agent.
 *
 * Includes the full XML analysis and the target interview stage
 * so the coach can tailor preparation accordingly.
 *
 * @param analysis - The Strategist Agent's XML analysis output
 * @param ctx - Pipeline context with interview stage
 * @returns Formatted user message
 */
function buildCoachMessage(
    analysis: StrategistAnalysisResult,
    ctx: StrategistPipelineContext,
): string {
    const sections: string[] = [
        `## Interview Stage: ${ctx.interviewStage}`,
        `Target Role: ${ctx.targetRole}`,
        `Target Company: ${ctx.targetCompany}`,
        `Overall Fit: ${analysis.metadata.overallFitRating}`,
        `Recommendation: ${analysis.metadata.applicationRecommendation}`,
        '',
        '## Full Analysis',
        '--- BEGIN ANALYSIS ---',
        analysis.analysisXml,
        '--- END ANALYSIS ---',
        '',
        `Prepare interview coaching for the "${ctx.interviewStage}" stage. ` +
        'Use ONLY verified skills and projects from the analysis. ' +
        'Return the JSON coaching brief.',
    ];

    return sections.join('\n');
}

// =============================================================================
// COACH AGENT CLASS
// =============================================================================

/** Agent configuration for the Interview Coach Agent. */
const COACH_CONFIG: AgentConfig = {
    agentName: 'strategist-coach',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: COACH_MAX_TOKENS,
    thinkingBudget: COACH_THINKING_BUDGET,
    systemPrompt: COACH_PERSONA_SYSTEM_PROMPT,
};

/**
 * Interview Coach Agent — Stage-specific interview preparation.
 *
 * Extends {@link BaseAgent} to encapsulate the Coach lifecycle:
 * - Receives the Strategist's full XML analysis
 * - Produces targeted coaching for the current interview stage
 * - Uses Haiku 4.5 for fast, conversational output
 *
 * @example
 * ```typescript
 * const result = await coachAgent.execute({ analysis }, ctx);
 * ```
 */
class CoachAgent extends BaseAgent<CoachAgentInput, InterviewCoachResult, StrategistPipelineContext> {
    protected readonly agentName = 'strategist-coach' as const;

    /**
     * Build coach configuration.
     *
     * @returns Static coach agent configuration
     */
    protected getConfig(): AgentConfig {
        return COACH_CONFIG;
    }

    /**
     * Build the user message for interview coaching.
     *
     * @param input - Coach input with analysis result
     * @param ctx   - Pipeline context with interview stage
     * @returns Formatted user message for Bedrock
     */
    protected buildUserMessage(input: CoachAgentInput, ctx: StrategistPipelineContext): string {
        return buildCoachMessage(input.analysis, ctx);
    }

    /**
     * Parse the raw LLM text into a typed InterviewCoachResult.
     *
     * Uses `ctx.interviewStage` to inject the stage into the parsed
     * result — previously achieved via a closure.
     *
     * @param responseText - Raw text response from Bedrock
     * @param _input       - Unused (coach doesn't need input in parser)
     * @param ctx          - Pipeline context for interview stage
     * @returns Validated coaching result
     */
    protected parseResponse(
        responseText: string,
        _input: CoachAgentInput,
        ctx: StrategistPipelineContext,
    ): InterviewCoachResult {
        const parsed = parseJsonResponse<InterviewCoachResult>(responseText, 'strategist-coach');

        return {
            ...parsed,
            stage: ctx.interviewStage,
            technicalQuestions: Array.isArray(parsed.technicalQuestions) ? parsed.technicalQuestions : [],
            behaviouralQuestions: Array.isArray(parsed.behaviouralQuestions) ? parsed.behaviouralQuestions : [],
            difficultQuestions: Array.isArray(parsed.difficultQuestions) ? parsed.difficultQuestions : [],
            technicalPrepChecklist: Array.isArray(parsed.technicalPrepChecklist) ? parsed.technicalPrepChecklist : [],
            questionsToAsk: Array.isArray(parsed.questionsToAsk) ? parsed.questionsToAsk : [],
        };
    }

    /**
     * Pre-execution hook — logs coaching context.
     *
     * @param _input - Unused
     * @param ctx    - Pipeline context
     */
    protected override beforeExecute(_input: CoachAgentInput, ctx: StrategistPipelineContext): void {
        log('INFO', 'Preparing coaching', {
            agent: 'strategist-coach',
            pipelineId: ctx.pipelineId,
            interviewStage: ctx.interviewStage,
            targetRole: ctx.targetRole,
        });
    }

    /**
     * Post-execution hook — logs coaching output.
     *
     * @param result - Coach agent result
     */
    protected override afterExecute(result: AgentResult<InterviewCoachResult>): void {
        log('INFO', 'Coaching prepared', {
            agent: 'strategist-coach',
            stage: result.data.stage,
            technical: result.data.technicalQuestions.length,
            behavioural: result.data.behaviouralQuestions.length,
            difficult: result.data.difficultQuestions.length,
        });
    }
}

/** Module-level singleton — re-used across Lambda invocations. */
const coachAgent = new CoachAgent();

/** Export the agent instance for direct usage. */
export { coachAgent, CoachAgent };

/**
 * Execute the Interview Coach Agent.
 *
 * Backward-compatible wrapper that delegates to the
 * {@link CoachAgent} class instance.
 *
 * @param ctx - Pipeline context with interview stage
 * @param analysis - Strategist Agent's analysis output
 * @returns Interview coaching result with stage-specific preparation
 */
export async function executeCoachAgent(
    ctx: StrategistPipelineContext,
    analysis: StrategistAnalysisResult,
): Promise<AgentResult<InterviewCoachResult>> {
    return coachAgent.execute({ analysis }, ctx);
}
