/**
 * @format
 * Strategist Agent — 5-Phase Analysis & Document Generation
 *
 * Second agent in the 3-agent strategist pipeline. Receives the
 * Research Agent's structured brief and produces the full XML
 * analysis following the 5-phase framework (Phases 1–4).
 *
 * Uses Sonnet 4.6 for complex reasoning with extended thinking
 * enabled for document crafting.
 *
 * Pipeline position: API → Research → **Strategist** → Coach → DynamoDB
 */

import { runAgent } from '../../../shared/src/index.js';
import { formatResumeForPrompt } from '../services/resume-service.js';
import { STRATEGIST_PERSONA_SYSTEM_PROMPT } from '../prompts/strategist-persona.js';
import { sanitiseOutput } from '../security/output-sanitiser.js';
import {
    FitRatingSchema,
    ApplicationRecommendationSchema,
} from '../schemas/dynamo-record.schema.js';
import type {
    AgentConfig,
    AgentResult,
    ResumeAdditionSuggestion,
    ResumeReframeSuggestion,
    ResumeEslCorrection,
    ResumeSuggestions,
    StrategistPipelineContext,
    StrategistResearchResult,
    StrategistAnalysisResult,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Strategist model — Sonnet 4.6 for complex reasoning */
const STRATEGIST_MODEL = process.env.STRATEGIST_MODEL ?? 'eu.anthropic.claude-sonnet-4-6';

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? STRATEGIST_MODEL;

/** Maximum output tokens — large budget for full XML analysis */
const STRATEGIST_MAX_TOKENS = 16384;

/** Extended thinking budget for complex document crafting */
const STRATEGIST_THINKING_BUDGET = 12288;

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Strategist Agent.
 *
 * Formats the research brief as structured context for the
 * 5-phase analysis framework.
 *
 * @param research - Structured research result from the Research Agent
 * @param ctx - Pipeline context
 * @returns Formatted user message
 */
function buildStrategistMessage(
    research: StrategistResearchResult,
    ctx: StrategistPipelineContext,
): string {
    const sections: string[] = [
        '## Research Agent Brief',
        `Target Role: ${research.targetRole}`,
        `Target Company: ${research.targetCompany}`,
        `Seniority: ${research.seniority}`,
        `Domain: ${research.domain}`,
        `Overall Fit Rating: ${research.overallFitRating}`,
        `Fit Summary: ${research.fitSummary}`,
        '',
    ];

    // Hard requirements
    sections.push('### Hard Requirements');
    for (const req of research.hardRequirements) {
        sections.push(`- **${req.skill}**: ${req.context} ${req.disqualifying ? '⚠️ DISQUALIFYING' : ''}`);
    }

    sections.push('', '### Soft Requirements');
    for (const req of research.softRequirements) {
        sections.push(`- **${req.skill}**: ${req.context}`);
    }

    if (research.implicitRequirements.length > 0) {
        sections.push('', '### Implicit Requirements');
        for (const req of research.implicitRequirements) {
            sections.push(`- ${req}`);
        }
    }

    // Technology inventory (guarded — upstream parseResponse provides defaults,
    // but belt-and-braces for robustness against LLM output variations)
    const techInv = research.technologyInventory;
    sections.push(
        '', '### Technology Inventory',
        `Languages: ${(techInv?.languages ?? []).join(', ') || 'None specified'}`,
        `Frameworks: ${(techInv?.frameworks ?? []).join(', ') || 'None specified'}`,
        `Infrastructure: ${(techInv?.infrastructure ?? []).join(', ') || 'None specified'}`,
        `Tools: ${(techInv?.tools ?? []).join(', ') || 'None specified'}`,
        `Methodologies: ${(techInv?.methodologies ?? []).join(', ') || 'None specified'}`,
    );

    // Verified matches — batched push to satisfy lint
    const verifiedLines = research.verifiedMatches.map(
        (m) => `- **${m.skill}** [${m.depth}]: ${m.sourceCitation} (${m.recency})`,
    );
    sections.push('', '### Verified Matches (Evidence-Backed)', ...verifiedLines);

    // Partial matches
    sections.push('', '### Partial Matches (Transferable)');
    for (const partial of research.partialMatches) {
        sections.push(
            `- **${partial.skill}**: ${partial.gapDescription}`,
            `  Foundation: ${partial.transferableFoundation}`,
            `  Framing: ${partial.framingSuggestion}`,
        );
    }

    // Gaps
    sections.push('', '### Gaps');
    for (const gap of research.gaps) {
        sections.push(`- **${gap.skill}** [${gap.gapType}/${gap.impactSeverity}]: ${gap.disqualifyingAssessment}`);
    }

    // Resume data (structured JSON from pipeline context, formatted as sectioned text)
    if (research.resumeData) {
        sections.push(
            '', '### Current Resume Content (Content Reference — Draft)',
            'This is the candidate\u2019s current resume. Use as content and style baseline.',
            'If constraint rules (above or below) conflict with resume wording, the constraints take precedence.',
            '--- BEGIN RESUME ---',
            formatResumeForPrompt(research.resumeData),
            '--- END RESUME ---',
        );
    }

    // Resume domain constraints (mandatory rules, gaps, and status thresholds)
    if (research.resumeConstraints) {
        sections.push(
            '', '### Resume Domain Constraints (MANDATORY — Read Before Generating Bullets)',
            'These are NON-NEGOTIABLE rules and gap boundaries from the resume domain KB.',
            'Apply these constraints BEFORE and AFTER generating each achievement bullet.',
            '--- BEGIN CONSTRAINTS ---',
            research.resumeConstraints,
            '--- END CONSTRAINTS ---',
        );
    }

    // Interview stage context and closing instruction
    const shouldIncludeCoverLetter = ctx.includeCoverLetter ?? true;
    const coverLetterDirective = shouldIncludeCoverLetter
        ? 'Include a full cover letter in the <cover_letter> section.'
        : 'SKIP the cover letter — leave the <cover_letter> section as an empty CDATA block: <cover_letter><![CDATA[]]></cover_letter>';

    sections.push(
        '', `### Current Interview Stage: ${ctx.interviewStage}`,
        '', coverLetterDirective,
        '', 'Execute Phases 1–4 of the analysis framework and return the complete XML output.',
    );

    return sections.join('\n');
}


// =============================================================================
// XML METADATA EXTRACTION
// =============================================================================

/**
 * Extract key metadata fields from the XML analysis output.
 *
 * Uses simple regex extraction rather than a full XML parser to
 * avoid additional dependencies in the Lambda bundle.
 *
 * FitRating and ApplicationRecommendation values are Zod-validated
 * against their respective enum schemas. Invalid values fall back
 * to safe defaults via `.catch()`.
 *
 * @param xml - Raw XML analysis output
 * @returns Extracted metadata fields
 */
function extractMetadataFromXml(xml: string): StrategistAnalysisResult['metadata'] {
    const extract = (tag: string): string => {
        const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, 's');
        const result = regex.exec(xml);
        return result?.[1]?.trim() ?? '';
    };

    return {
        candidateName: extract('candidate_name'),
        targetRole: extract('target_role'),
        targetCompany: extract('target_company'),
        analysisDate: extract('analysis_date'),
        overallFitRating: FitRatingSchema.catch('STRETCH').parse(extract('overall_fit_rating')),
        applicationRecommendation: ApplicationRecommendationSchema.catch('APPLY WITH CAVEATS').parse(extract('application_recommendation')),
    };
}

/**
 * Extract the cover letter from the XML analysis.
 *
 * @param xml - Raw XML analysis output
 * @returns Cover letter text
 */
function extractCoverLetter(xml: string): string {
    const coverLetterRegex = /<cover_letter><!\[CDATA\[(.*?)\]\]><\/cover_letter>/s;
    const result = coverLetterRegex.exec(xml);
    return result?.[1]?.trim() ?? '';
}

/**
 * Count specific XML elements in the analysis.
 *
 * @param xml - Raw XML analysis output
 * @param tag - XML tag to count
 * @returns Number of occurrences
 */
function countXmlElements(xml: string, tag: string): number {
    const regex = new RegExp(`<${tag}>`, 'g');
    let count = 0;
    while (regex.exec(xml) !== null) {
        count += 1;
    }
    return count;
}

/**
 * Extract structured addition suggestions from the XML analysis.
 *
 * Parses `<addition>` elements within `<resume_tailoring>`, extracting
 * the target section, suggested bullet text, and KB citation.
 *
 * @param xml - Raw XML analysis output
 * @returns Array of structured addition suggestions
 */
function extractAdditions(xml: string): ResumeAdditionSuggestion[] {
    const additions: ResumeAdditionSuggestion[] = [];
    const regex = /<addition>\s*<section>(.*?)<\/section>\s*<suggested_bullet>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/suggested_bullet>\s*<source_citation>(.*?)<\/source_citation>\s*<\/addition>/gs;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
        additions.push({
            section: match[1].trim(),
            suggestedBullet: match[2].trim(),
            sourceCitation: match[3].trim(),
        });
    }
    return additions;
}

/**
 * Extract structured reframe suggestions from the XML analysis.
 *
 * Parses `<reframe>` elements within `<resume_tailoring>`, extracting
 * the original text, suggested replacement, and rationale.
 *
 * @param xml - Raw XML analysis output
 * @returns Array of structured reframe suggestions
 */
function extractReframes(xml: string): ResumeReframeSuggestion[] {
    const reframes: ResumeReframeSuggestion[] = [];
    const regex = /<reframe>\s*<original>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/original>\s*<suggested>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/suggested>\s*<rationale>(.*?)<\/rationale>\s*<\/reframe>/gs;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
        reframes.push({
            original: match[1].trim(),
            suggested: match[2].trim(),
            rationale: match[3].trim(),
        });
    }
    return reframes;
}

/**
 * Extract structured ESL corrections from the XML analysis.
 *
 * Parses `<correction>` elements within `<esl_corrections>`, extracting
 * the original error and corrected text.
 *
 * @param xml - Raw XML analysis output
 * @returns Array of structured ESL corrections
 */
function extractEslCorrections(xml: string): ResumeEslCorrection[] {
    const corrections: ResumeEslCorrection[] = [];
    const regex = /<correction>\s*<original>(.*?)<\/original>\s*<corrected>(.*?)<\/corrected>\s*<\/correction>/gs;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
        corrections.push({
            original: match[1].trim(),
            corrected: match[2].trim(),
        });
    }
    return corrections;
}

/**
 * Build the complete ResumeSuggestions object from XML.
 *
 * Extracts all structured suggestion data from the `<resume_tailoring>`
 * section of the Strategist Agent's XML output.
 *
 * @param xml - Raw XML analysis output
 * @returns Structured resume suggestions
 */
function buildResumeSuggestions(xml: string): ResumeSuggestions {
    return {
        additions: extractAdditions(xml),
        reframes: extractReframes(xml),
        eslCorrections: extractEslCorrections(xml),
    };
}

// =============================================================================
// AGENT EXECUTION
// =============================================================================

/**
 * Agent configuration for the Strategist Agent.
 */
const STRATEGIST_CONFIG: AgentConfig = {
    agentName: 'strategist-writer',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: STRATEGIST_MAX_TOKENS,
    thinkingBudget: STRATEGIST_THINKING_BUDGET,
    systemPrompt: STRATEGIST_PERSONA_SYSTEM_PROMPT,
};

/**
 * Execute the Strategist Agent.
 *
 * Receives the Research Agent's structured brief and produces
 * the full 5-phase XML analysis with document generation.
 *
 * @param ctx - Pipeline context
 * @param research - Research Agent's structured output
 * @returns Full XML analysis with metadata extraction
 */
export async function executeStrategistAgent(
    ctx: StrategistPipelineContext,
    research: StrategistResearchResult,
): Promise<AgentResult<StrategistAnalysisResult>> {
    console.log(
        `[strategist-writer] Pipeline ${ctx.pipelineId} — generating analysis for ` +
        `"${research.targetRole}" at "${research.targetCompany}"`,
    );

    const userMessage = buildStrategistMessage(research, ctx);

    const result = await runAgent<StrategistAnalysisResult>({
        config: STRATEGIST_CONFIG,
        userMessage,
        parseResponse: (text) => {
            // Sanitise output to redact any infrastructure identifiers
            const sanitisedXml = sanitiseOutput(text);

            // Extract metadata from XML for quick DynamoDB queries
            const metadata = extractMetadataFromXml(sanitisedXml);
            const shouldIncludeCoverLetter = ctx.includeCoverLetter ?? true;
            const coverLetter = shouldIncludeCoverLetter
                ? extractCoverLetter(sanitisedXml)
                : null;
            const resumeSuggestions = buildResumeSuggestions(sanitisedXml);

            return {
                analysisXml: sanitisedXml,
                metadata,
                coverLetter,
                resumeSuggestions,
                resumeAdditions: resumeSuggestions.additions.length,
                resumeReframes: resumeSuggestions.reframes.length,
                eslCorrections: resumeSuggestions.eslCorrections.length,
            };
        },
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            slug: ctx.applicationSlug,
            sourceKey: '',
            bucket: ctx.bucket,
            environment: ctx.environment,
            version: 0, // Strategist pipeline — not versioned
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
            retryAttempt: 0,
            startedAt: ctx.startedAt,
        },
    });

    console.log(
        `[strategist-writer] Analysis generated — fit="${result.data.metadata.overallFitRating}", ` +
        `recommendation="${result.data.metadata.applicationRecommendation}", ` +
        `additions=${result.data.resumeAdditions}, reframes=${result.data.resumeReframes}, ` +
        `esl=${result.data.eslCorrections}`,
    );

    return result;
}
