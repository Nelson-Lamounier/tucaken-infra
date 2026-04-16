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

import { runAgent, parseJsonResponse } from '../../../shared/src/index.js';
import { COACH_PERSONA_SYSTEM_PROMPT } from '../prompts/coach-persona.js';
import type {
    AgentConfig,
    AgentResult,
    StrategistPipelineContext,
    StrategistAnalysisResult,
    InterviewCoachResult,
} from '../../../shared/src/index.js';

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
// AGENT EXECUTION
// =============================================================================

/**
 * Agent configuration for the Interview Coach Agent.
 */
const COACH_CONFIG: AgentConfig = {
    agentName: 'strategist-coach',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: COACH_MAX_TOKENS,
    thinkingBudget: COACH_THINKING_BUDGET,
    systemPrompt: COACH_PERSONA_SYSTEM_PROMPT,
};

/**
 * Execute the Interview Coach Agent.
 *
 * Receives the Strategist's analysis and produces targeted
 * interview preparation for the current stage.
 *
 * @param ctx - Pipeline context with interview stage
 * @param analysis - Strategist Agent's analysis output
 * @returns Interview coaching result with stage-specific preparation
 */
export async function executeCoachAgent(
    ctx: StrategistPipelineContext,
    analysis: StrategistAnalysisResult,
): Promise<AgentResult<InterviewCoachResult>> {
    console.log(
        `[strategist-coach] Pipeline ${ctx.pipelineId} — preparing "${ctx.interviewStage}" stage ` +
        `coaching for "${ctx.targetRole}"`,
    );

    const userMessage = buildCoachMessage(analysis, ctx);

    const result = await runAgent<InterviewCoachResult>({
        config: COACH_CONFIG,
        userMessage,
        parseResponse: (text) => {
            const parsed = parseJsonResponse<InterviewCoachResult>(text, 'strategist-coach');

            // Ensure arrays are always arrays
            return {
                ...parsed,
                stage: ctx.interviewStage,
                technicalQuestions: Array.isArray(parsed.technicalQuestions) ? parsed.technicalQuestions : [],
                behaviouralQuestions: Array.isArray(parsed.behaviouralQuestions) ? parsed.behaviouralQuestions : [],
                difficultQuestions: Array.isArray(parsed.difficultQuestions) ? parsed.difficultQuestions : [],
                technicalPrepChecklist: Array.isArray(parsed.technicalPrepChecklist) ? parsed.technicalPrepChecklist : [],
                questionsToAsk: Array.isArray(parsed.questionsToAsk) ? parsed.questionsToAsk : [],
            };
        },
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            slug: ctx.applicationSlug,
            sourceKey: '',
            bucket: ctx.bucket,
            environment: ctx.environment,
            version: 0, // Coach pipeline has no article versioning; sentinel value
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
            retryAttempt: 0,
            startedAt: ctx.startedAt,
        },
    });

    console.log(
        `[strategist-coach] Coaching prepared — stage="${result.data.stage}", ` +
        `technical=${result.data.technicalQuestions.length}, ` +
        `behavioural=${result.data.behaviouralQuestions.length}, ` +
        `difficult=${result.data.difficultQuestions.length}`,
    );

    return result;
}
