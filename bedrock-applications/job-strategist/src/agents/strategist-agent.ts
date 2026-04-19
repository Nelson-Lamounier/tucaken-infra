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

import { runAgent, parseJsonResponse } from '../../../shared/src/index.js';
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
    RoleArchetypeSelection,
    ArchetypeId,
    StrategistPipelineContext,
    StrategistResearchResult,
    StrategistAnalysisResult,
    StructuredResumeData,
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

/**
 * Maximum output tokens — read from CDK-injected env var (MAX_TOKENS).
 * Fallback: 64,000 (supports full XML analysis + tailored resume JSON).
 * CDK allocations in strategist-allocations.ts are the authoritative source.
 */
const STRATEGIST_MAX_TOKENS = Number(process.env.MAX_TOKENS ?? '64000');

/**
 * Extended thinking budget — read from CDK-injected env var (THINKING_BUDGET_TOKENS).
 * Must be < STRATEGIST_MAX_TOKENS. Bedrock carves this from the maxTokens ceiling.
 * Fallback: 16,384 (leaves ~47k tokens for text output).
 */
const STRATEGIST_THINKING_BUDGET = Number(process.env.THINKING_BUDGET_TOKENS ?? '16384');

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

    // Resume data — PATH B formatting reference only. All content comes from KB.
    if (research.resumeData) {
        sections.push(
            '', '### PATH B — Uploaded Resume (FORMATTING REFERENCE ONLY)',
            '',
            '⚠️  CONTENT PROHIBITION — NEVER VIOLATE:',
            'Do NOT copy, paraphrase, or derive any content from this document.',
            'PERMITTED: section ordering preference, header/contact block format only.',
            'PROHIBITED: any bullet, summary, skill list, or project description from this document.',
            'All resume content must be generated from the KB evidence in the research brief above.',
            'If this document\'s structure conflicts with the Phase 0 archetype ordering, the ARCHETYPE WINS.',
            'If a section appears here but has no KB evidence, leave it EMPTY — do not copy to fill.',
            '--- BEGIN FORMATTING REFERENCE ---',
            formatResumeForPrompt(research.resumeData),
            '--- END FORMATTING REFERENCE ---',
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
 * section of the Strategist Agent's XML output. Retained for admin UI
 * audit trail — no longer used by Resume Builder for patch application.
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
// PHASE 0 ARCHETYPE EXTRACTION
// =============================================================================

/**
 * Pull inner tag values out of a parent content block.
 *
 * Uses String.matchAll — avoids exec() to prevent false-positive
 * security hook triggers on RegExp.prototype.exec() patterns.
 */
function extractTagArray(content: string, tag: string): string[] {
    const pattern = new RegExp(`<${tag}>(.*?)</${tag}>`, 'gs');
    return Array.from(content.matchAll(pattern)).map((m) => m[1].trim());
}

/** Extract a single plain-text tag value from a content block. */
function extractTagValue(content: string, tag: string): string {
    const pattern = new RegExp(`<${tag}>(.*?)</${tag}>`, 's');
    return content.match(pattern)?.[1]?.trim() ?? '';
}

/** Extract a CDATA-wrapped tag value (falls back to plain-text tag). */
function extractCdataValue(content: string, tag: string): string {
    const cdataPattern = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`);
    const raw = content.match(cdataPattern)?.[1]?.trim();
    return raw ?? extractTagValue(content, tag);
}

/**
 * Extract the Phase 0 archetype selection from the XML analysis.
 *
 * Parses the `<phase_0_archetype_selection>` section introduced in the
 * Option A architecture. Returns null when the section is absent (legacy
 * runs or Strategist output that predates Phase 0).
 *
 * @param xml - Raw XML analysis output
 * @returns Parsed archetype selection, or null
 */
function extractArchetypeSelection(xml: string): RoleArchetypeSelection | null {
    const sectionPattern = /<phase_0_archetype_selection>([\s\S]*?)<\/phase_0_archetype_selection>/;
    const sectionMatch = xml.match(sectionPattern);
    if (!sectionMatch) return null;

    const content = sectionMatch[1];

    const triggerBlock = content.match(/<trigger_phrases_matched>([\s\S]*?)<\/trigger_phrases_matched>/)?.[1] ?? '';
    const excludedBlock = content.match(/<excluded_content_categories>([\s\S]*?)<\/excluded_content_categories>/)?.[1] ?? '';

    const archetypeIdRaw = parseInt(extractTagValue(content, 'archetype_id'), 10);
    const archetypeId: ArchetypeId = ([1, 2, 3, 4, 5, 6].includes(archetypeIdRaw)
        ? archetypeIdRaw
        : 1) as ArchetypeId;

    const confidenceRaw = parseFloat(extractTagValue(content, 'confidence_score'));
    const confidenceScore = isNaN(confidenceRaw) ? 0.5 : Math.min(1, Math.max(0, confidenceRaw));

    return {
        selectedArchetype: extractTagValue(content, 'selected_archetype'),
        archetypeId,
        triggerPhrasesMatched: extractTagArray(triggerBlock, 'phrase'),
        excludedContentCategories: extractTagArray(excludedBlock, 'category'),
        leadIdentity: extractCdataValue(content, 'lead_identity'),
        confidenceScore,
        archetypeGapDetected: extractTagValue(content, 'archetype_gap_detected') === 'true',
    };
}

// =============================================================================
// TAILORED RESUME JSON EXTRACTION
// =============================================================================

/**
 * Extract the complete tailored resume JSON from the XML analysis.
 *
 * Parses the `<tailored_resume_json>` CDATA section in Phase 4.
 * This is the authoritative resume output produced by the Strategist
 * Agent — the Resume Builder handler persists it directly to DynamoDB
 * without any further LLM transformation.
 *
 * Returns null when the section is absent (build-from-scratch runs
 * without base resume data, or legacy Strategist output).
 *
 * @param xml - Raw XML analysis output
 * @returns Parsed StructuredResumeData, or null
 */
function extractTailoredResumeJson(xml: string): StructuredResumeData | null {
    const cdataPattern = /<tailored_resume_json><!\[CDATA\[([\s\S]*?)\]\]><\/tailored_resume_json>/;
    const match = xml.match(cdataPattern);
    if (!match) return null;

    const raw = match[1].trim();
    if (!raw) return null;

    try {
        return parseJsonResponse<StructuredResumeData>(raw, 'strategist-tailored-resume');
    } catch (err) {
        console.warn(`[strategist-writer] Failed to parse tailored_resume_json: ${(err as Error).message}`);
        return null;
    }
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

            // Phase 0 — archetype selection (explicit, auditable)
            const archetypeSelection = extractArchetypeSelection(sanitisedXml);
            if (archetypeSelection) {
                console.log(
                    `[strategist-writer] Phase 0 — archetype="${archetypeSelection.selectedArchetype}" ` +
                    `(id=${archetypeSelection.archetypeId}, confidence=${archetypeSelection.confidenceScore.toFixed(2)}, ` +
                    `gap=${archetypeSelection.archetypeGapDetected})`,
                );
            } else {
                console.warn(`[strategist-writer] Phase 0 section absent — legacy or build-from-scratch run`);
            }

            // Phase 4 — extract complete tailored resume JSON (Option A architecture)
            const tailoredResumeData = extractTailoredResumeJson(sanitisedXml);
            if (tailoredResumeData) {
                console.log(`[strategist-writer] Tailored resume JSON extracted — Resume Builder will persist directly`);
            } else {
                console.warn(`[strategist-writer] No tailored_resume_json section found — Resume Builder will skip`);
            }

            return {
                analysisXml: sanitisedXml,
                metadata,
                coverLetter,
                archetypeSelection,
                tailoredResumeData,
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
        `archetype="${result.data.archetypeSelection?.selectedArchetype ?? 'unknown'}", ` +
        `tailoredResume=${result.data.tailoredResumeData !== null}, ` +
        `additions=${result.data.resumeAdditions}, reframes=${result.data.resumeReframes}, ` +
        `esl=${result.data.eslCorrections}`,
    );

    return result;
}
