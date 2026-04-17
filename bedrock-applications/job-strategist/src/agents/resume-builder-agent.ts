/**
 * @format
 * Resume Builder Agent — Phase 4b Structured Resume Generation
 *
 * Third agent in the analysis pipeline. Receives the original
 * StructuredResumeData and the Strategist Agent's resume suggestions,
 * then produces a complete tailored StructuredResumeData with all
 * suggestions applied.
 *
 * Uses Haiku 4.5 for structured JSON-to-JSON transformation.
 *
 * Pipeline position: API → Research → Strategist → **ResumeBuilder** → Persist
 */

import { runAgent, parseJsonResponse } from '../../../shared/src/index.js';
import { RESUME_BUILDER_PERSONA_SYSTEM_PROMPT } from '../prompts/resume-builder-persona.js';
import type {
    AgentConfig,
    AgentResult,
    StructuredResumeData,
    StrategistPipelineContext,
    ResumeSuggestions,
    TailoredResumeResult,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Resume Builder model — Haiku 4.5 for structured transformation */
const RESUME_BUILDER_MODEL = process.env.RESUME_BUILDER_MODEL ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? RESUME_BUILDER_MODEL;

/**
 * Maximum output tokens for the full JSON resume.
 *
 * Resume-builder is a deterministic JSON-to-JSON transformation — extended
 * thinking is disabled (budget = 0) so ALL tokens go to text output.
 * With a 370-word experience section, 160-word projects, and full JSON
 * scaffolding, a tailored resume can reach 6,000–10,000 output tokens.
 */
const RESUME_BUILDER_MAX_TOKENS = 16_000;

/** Thinking disabled — structured editing does not benefit from reasoning. */
const RESUME_BUILDER_THINKING_BUDGET = 0;

/** Agent name for logging and metrics */
const AGENT_NAME = 'resume-builder' as const;

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Format a suggestion section for the user message.
 *
 * @param heading - Markdown heading for the section
 * @param items - Array of suggestion items (empty → "No X to apply.")
 * @param emptyLabel - Label used in the "No X to apply." fallback
 * @returns Array of formatted lines
 */
function formatSuggestionSection(
    heading: string,
    items: readonly unknown[],
    emptyLabel: string,
): string[] {
    return [
        heading,
        items.length === 0
            ? `No ${emptyLabel} to apply.`
            : JSON.stringify(items, null, 2),
        ``,
    ];
}

/**
 * Build the user message for the Resume Builder Agent.
 *
 * Formats the original resume and edit suggestions as structured
 * input for the JSON transformation task.
 *
 * @param resumeData - Original structured resume data
 * @param suggestions - Resume tailoring suggestions from the Strategist Agent
 * @param targetRole - Target job role for context
 * @param targetCompany - Target company for context
 * @returns Formatted user message
 */
function buildResumeBuilderMessage(
    resumeData: StructuredResumeData,
    suggestions: ResumeSuggestions,
    targetRole: string,
    targetCompany: string,
): string {
    const sections: string[] = [
        `## Context`,
        `Target Role: ${targetRole}`,
        `Target Company: ${targetCompany}`,
        ``,
        `## ORIGINAL RESUME (JSON)`,
        JSON.stringify(resumeData, null, 2),
        ``,
        ...formatSuggestionSection(`## ADDITIONS`, suggestions.additions, 'additions'),
        ...formatSuggestionSection(`## REFRAMES`, suggestions.reframes, 'reframes'),
        ...formatSuggestionSection(`## ESL CORRECTIONS`, suggestions.eslCorrections, 'ESL corrections'),
    ];

    return sections.join('\n');
}

// =============================================================================
// RESPONSE PARSER
// =============================================================================

/**
 * Parse the Resume Builder Agent's response into a TailoredResumeResult.
 *
 * The response contains a JSON object followed by an optional
 * CHANGES_SUMMARY line. We extract both.
 *
 * @param text - Raw model response text
 * @param suggestions - Original suggestions for counting applied changes
 * @returns Parsed tailored resume result
 */
function parseResumeBuilderResponse(
    text: string,
    suggestions: ResumeSuggestions,
): TailoredResumeResult {
    // Split response into JSON and summary
    const summaryMarker = 'CHANGES_SUMMARY:';
    const summaryIndex = text.lastIndexOf(summaryMarker);

    const hasSummary = summaryIndex >= 0;
    const jsonText = hasSummary
        ? text.slice(0, summaryIndex).trim()
        : text.trim();
    const changesSummary = hasSummary
        ? text.slice(summaryIndex + summaryMarker.length).trim()
        : `Applied ${suggestions.additions.length} additions, ` +
          `${suggestions.reframes.length} reframes, ` +
          `${suggestions.eslCorrections.length} ESL corrections`;

    // Strip markdown code fences if present
    const cleanedJson = jsonText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    const tailoredResume = parseJsonResponse<StructuredResumeData>(cleanedJson, AGENT_NAME);

    return {
        tailoredResume,
        changesSummary,
        additionsApplied: suggestions.additions.length,
        reframesApplied: suggestions.reframes.length,
        eslCorrectionsApplied: suggestions.eslCorrections.length,
    };
}

// =============================================================================
// AGENT EXECUTION
// =============================================================================

/** Agent configuration for the Resume Builder Agent. */
const RESUME_BUILDER_CONFIG: AgentConfig = {
    agentName: AGENT_NAME,
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: RESUME_BUILDER_MAX_TOKENS,
    thinkingBudget: RESUME_BUILDER_THINKING_BUDGET,
    systemPrompt: RESUME_BUILDER_PERSONA_SYSTEM_PROMPT,
};

/**
 * Execute the Resume Builder Agent.
 *
 * Receives the original resume data and the Strategist Agent's
 * suggestions, and produces a complete tailored resume with all
 * edits applied.
 *
 * @param ctx - Pipeline context
 * @param resumeData - Original structured resume data
 * @param suggestions - Resume tailoring suggestions from the Strategist
 * @returns Complete tailored resume result
 */
export async function executeResumeBuilderAgent(
    ctx: StrategistPipelineContext,
    resumeData: StructuredResumeData,
    suggestions: ResumeSuggestions,
): Promise<AgentResult<TailoredResumeResult>> {
    console.log(
        `[resume-builder] Pipeline ${ctx.pipelineId} — building tailored resume for ` +
        `"${ctx.targetRole}" at "${ctx.targetCompany}" ` +
        `(${suggestions.additions.length} additions, ` +
        `${suggestions.reframes.length} reframes, ` +
        `${suggestions.eslCorrections.length} ESL corrections)`,
    );

    const userMessage = buildResumeBuilderMessage(
        resumeData,
        suggestions,
        ctx.targetRole,
        ctx.targetCompany,
    );

    const result = await runAgent<TailoredResumeResult>({
        config: RESUME_BUILDER_CONFIG,
        userMessage,
        parseResponse: (text) => parseResumeBuilderResponse(text, suggestions),
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            slug: ctx.applicationSlug,
            sourceKey: '',
            bucket: ctx.bucket,
            environment: ctx.environment,
            version: 0,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
            retryAttempt: 0,
            startedAt: ctx.startedAt,
        },
    });

    console.log(
        `[resume-builder] Tailored resume generated — ` +
        `${result.data.additionsApplied} additions, ` +
        `${result.data.reframesApplied} reframes, ` +
        `${result.data.eslCorrectionsApplied} ESL corrections applied`,
    );

    return result;
}
