/**
 * @format
 * Strategist Research Agent — KB Retrieval, Resume Parsing & Gap Analysis
 *
 * First agent in the 3-agent strategist pipeline. Receives the raw
 * job description, queries the Pinecone Knowledge Base for portfolio
 * and project data, fetches the latest resume from DynamoDB, and
 * produces a structured research brief with verified/partial/gap
 * skill classification.
 *
 * Uses Haiku 4.5 for cost-efficient extraction and analysis.
 *
 * Pipeline position: API → **Research** → Strategist → Coach → DynamoDB
 */

import {
    BedrockAgentRuntimeClient,
    RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

import { runAgent, parseJsonResponse } from '../../../shared/src/index.js';
import { formatResumeForPrompt } from '../services/resume-service.js';
import { RESEARCH_PERSONA_SYSTEM_PROMPT } from '../prompts/research-persona.js';
import { sanitiseInput } from '../security/input-sanitiser.js';
import type {
    AgentConfig,
    AgentResult,
    StructuredResumeData,
    StrategistPipelineContext,
    StrategistResearchResult,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Research Agent model — set by CDK via RESEARCH_MODEL environment variable */
const RESEARCH_MODEL = process.env.RESEARCH_MODEL;
if (!RESEARCH_MODEL) {
    throw new Error(
        'Missing required environment variable RESEARCH_MODEL. ' +
        'This must be set by CDK infrastructure (e.g. eu.anthropic.claude-haiku-4-5-20251001-v1:0)',
    );
}

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? RESEARCH_MODEL;

/** Maximum output tokens */
const RESEARCH_MAX_TOKENS = 8192;

/** Thinking budget for analysis tasks */
const RESEARCH_THINKING_BUDGET = 4096;

/** Knowledge Base ID for Pinecone retrieval */
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID ?? '';

/** Maximum KB passages to retrieve */
const MAX_KB_PASSAGES = 15;

// =============================================================================
// CLIENTS
// =============================================================================

const bedrockAgentClient = new BedrockAgentRuntimeClient({});

// =============================================================================
// KNOWLEDGE BASE RETRIEVAL
// =============================================================================

/**
 * Execute a single KB retrieval query.
 *
 * @param query - Search query text for the Knowledge Base
 * @returns Raw passages with source/score metadata prefix
 */
async function querySingleKb(query: string): Promise<string[]> {
    if (!KNOWLEDGE_BASE_ID) {
        return [];
    }

    console.log(`[strategist-research] Querying KB with: "${query.substring(0, 80)}..."`);

    const command = new RetrieveCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        retrievalQuery: { text: query },
        retrievalConfiguration: {
            vectorSearchConfiguration: {
                numberOfResults: MAX_KB_PASSAGES,
            },
        },
    });

    const response = await bedrockAgentClient.send(command);
    const results = response.retrievalResults ?? [];
    const passages: string[] = [];

    for (const result of results) {
        if (result.content?.text) {
            const source = result.location?.s3Location?.uri ?? 'unknown';
            const score = result.score ?? 0;
            passages.push(
                `[Source: ${source}, Score: ${score.toFixed(3)}]\n${result.content.text}`,
            );
        }
    }

    return passages;
}

/**
 * Deduplicate KB passages by content only.
 *
 * The score prefix (e.g. `[Source: ..., Score: 0.87]`) differs across
 * queries, so a naive `new Set()` would treat identical text blocks
 * as distinct entries. This helper strips the first line (metadata)
 * before comparison.
 *
 * @param passages - Array of passages with `[Source: ..., Score: ...]\n<content>` format
 * @returns Deduplicated passages joined with separator, empty string if none
 */
function deduplicatePassages(passages: string[]): string {
    const seen = new Set<string>();
    const unique = passages.filter((passage) => {
        // Strip the metadata prefix line for content-only comparison
        const contentOnly = passage.split('\n').slice(1).join('\n');
        if (seen.has(contentOnly)) return false;
        seen.add(contentOnly);
        return true;
    });

    console.log(
        `[strategist-research] Deduplicated ${passages.length} passages → ${unique.length} unique`,
    );

    return unique.length > 0 ? unique.join('\n\n---\n\n') : '';
}

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Research Agent.
 *
 * Assembles the job description, KB context, and structured resume data into
 * a prompt with clearly delimited sections for analysis.
 *
 * @param jobDescription - Sanitised job description text
 * @param kbContext - Concatenated KB passages
 * @param resumeData - Structured resume data from pipeline context (may be null)
 * @returns Formatted user message
 */
function buildResearchMessage(
    jobDescription: string,
    kbContext: string,
    resumeData: StructuredResumeData | null,
): string {
    const sections: string[] = [
        '## Job Description',
        '--- BEGIN JOB DESCRIPTION ---',
        jobDescription,
        '--- END JOB DESCRIPTION ---',
        '',
    ];

    if (resumeData) {
        sections.push(
            '## Current Resume (Draft — DynamoDB)',
            'This is the candidate\u2019s current resume draft. Use it for content and style reference.',
            'If KB constraint pages (Gap Awareness, Agent Guide) conflict with resume wording,',
            'the KB constraints take precedence — flag the conflict and suggest a correction.',
            '--- BEGIN RESUME ---',
            formatResumeForPrompt(resumeData),
            '--- END RESUME ---',
            '',
        );
    }

    if (kbContext) {
        sections.push(
            '## Knowledge Base — Portfolio & Project Evidence',
            'The following passages were retrieved from the candidate\'s portfolio documentation.',
            'Use these to SUPPLEMENT and VERIFY the resume with verifiable project evidence.',
            'KB constraint passages (containing "NEVER", "ABSENT", "PROHIBITED") OVERRIDE resume wording.',
            '',
            kbContext,
            '',
        );
    }

    sections.push('Analyse this job description against the candidate\'s evidence and return the JSON research brief.');

    return sections.join('\n');
}

// =============================================================================
// AGENT EXECUTION
// =============================================================================

/**
 * Agent configuration for the Strategist Research Agent.
 */
const RESEARCH_CONFIG: AgentConfig = {
    agentName: 'strategist-research',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: RESEARCH_MAX_TOKENS,
    thinkingBudget: RESEARCH_THINKING_BUDGET,
    systemPrompt: RESEARCH_PERSONA_SYSTEM_PROMPT,
};

/**
 * Execute the Strategist Research Agent.
 *
 * 1. Sanitises the job description input
 * 2. Queries the Pinecone KB in parallel (3 factual + 2 constraint queries)
 * 3. Reads structured resume data from the pipeline context (fetched by trigger)
 * 4. Runs Haiku 4.5 to produce a structured research brief
 *
 * @param ctx - Pipeline context with job description and resumeData
 * @returns Research result with verified/partial/gap skill classification
 */
export async function executeResearchAgent(
    ctx: StrategistPipelineContext,
): Promise<AgentResult<StrategistResearchResult>> {
    // 1. Sanitise input
    console.log(`[strategist-research] Pipeline ${ctx.pipelineId} — analysing JD for "${ctx.targetRole}"`);
    const { sanitised, warnings, injectionDetected } = sanitiseInput(ctx.jobDescription);

    if (injectionDetected) {
        console.warn(`[strategist-research] Injection attempt detected — proceeding with sanitised input`);
    }
    for (const warning of warnings) {
        console.warn(`[strategist-research] ${warning}`);
    }

    // 2. Query Knowledge Base — 6 parallel queries (3 factual + 3 constraint)
    //    Factual queries retrieve project evidence and skills
    //    Constraint queries retrieve mandatory rules, gaps, status thresholds, and voice
    let kbContext = '';
    let resumeConstraints = '';

    if (KNOWLEDGE_BASE_ID) {
        const [factual1, factual2, factual3, agentRules, gapBoundaries, voiceLibrary] = await Promise.all([
            querySingleKb(sanitised.substring(0, 1000)),
            querySingleKb('resume professional experience skills qualifications'),
            querySingleKb('project architecture technical implementation deployment'),
            querySingleKb(
                'resume generation agent instructions confidence thresholds STRONG PARTIAL ABSENT hard rules',
            ),
            querySingleKb(
                'resume honest boundaries what not to claim gaps absent overclaim service mesh SLA',
            ),
            querySingleKb(
                'candidate writing voice authentic language personal phrases tone style',
            ),
        ]);

        // Factual context — evidence for achievement bullet generation
        const allFactualPassages = [...factual1, ...factual2, ...factual3];
        kbContext = deduplicatePassages(allFactualPassages);

        // Resume domain constraints — rules, gaps, status thresholds, and voice anchoring (non-negotiable)
        const allConstraintPassages = [...agentRules, ...gapBoundaries, ...voiceLibrary];
        resumeConstraints = deduplicatePassages(allConstraintPassages);

        console.log(
            `[strategist-research] KB retrieval complete — ` +
            `factual=${kbContext.length > 0 ? `${(kbContext.length / 1024).toFixed(1)}KB` : 'empty'}, ` +
            `constraints=${resumeConstraints.length > 0 ? `${(resumeConstraints.length / 1024).toFixed(1)}KB` : 'empty'}`,
        );
    } else {
        console.log('[strategist-research] KB retrieval skipped — no KNOWLEDGE_BASE_ID configured');
    }

    // 3. Read resume from pipeline context (fetched at trigger time)
    const resumeData = ctx.resumeData;
    if (!resumeData) {
        console.warn('[strategist-research] No resume data in pipeline context — analysis will proceed without resume baseline');
    } else {
        console.log(`[strategist-research] Resume loaded from context: ${resumeData.profile.name}`);
    }

    // 4. Build user message
    const userMessage = buildResearchMessage(sanitised, kbContext, resumeData);

    // 5. Run agent
    const result = await runAgent<StrategistResearchResult>({
        config: RESEARCH_CONFIG,
        userMessage,
        parseResponse: (text) => {
            const parsed = parseJsonResponse<StrategistResearchResult>(text, 'strategist-research');

            // Ensure arrays are always arrays (defensive against LLM output)
            // and provide safe defaults for nested objects the LLM might omit
            return {
                ...parsed,
                targetRole: parsed.targetRole ?? 'Unknown Role',
                targetCompany: parsed.targetCompany ?? 'Unknown Company',
                seniority: parsed.seniority ?? 'unspecified',
                domain: parsed.domain ?? 'unspecified',
                hardRequirements: Array.isArray(parsed.hardRequirements) ? parsed.hardRequirements : [],
                softRequirements: Array.isArray(parsed.softRequirements) ? parsed.softRequirements : [],
                implicitRequirements: Array.isArray(parsed.implicitRequirements) ? parsed.implicitRequirements : [],
                verifiedMatches: Array.isArray(parsed.verifiedMatches) ? parsed.verifiedMatches : [],
                partialMatches: Array.isArray(parsed.partialMatches) ? parsed.partialMatches : [],
                gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
                technologyInventory: {
                    languages: Array.isArray(parsed.technologyInventory?.languages) ? parsed.technologyInventory.languages : [],
                    frameworks: Array.isArray(parsed.technologyInventory?.frameworks) ? parsed.technologyInventory.frameworks : [],
                    infrastructure: Array.isArray(parsed.technologyInventory?.infrastructure) ? parsed.technologyInventory.infrastructure : [],
                    tools: Array.isArray(parsed.technologyInventory?.tools) ? parsed.technologyInventory.tools : [],
                    methodologies: Array.isArray(parsed.technologyInventory?.methodologies) ? parsed.technologyInventory.methodologies : [],
                },
                experienceSignals: {
                    yearsExpected: parsed.experienceSignals?.yearsExpected ?? 'unspecified',
                    domainExperience: parsed.experienceSignals?.domainExperience ?? 'unspecified',
                    leadershipExpectation: parsed.experienceSignals?.leadershipExpectation ?? 'none specified',
                    scaleIndicators: parsed.experienceSignals?.scaleIndicators ?? 'unspecified',
                },
                overallFitRating: parsed.overallFitRating ?? 'STRETCH',
                fitSummary: parsed.fitSummary ?? 'Analysis incomplete — insufficient data for assessment.',
                resumeData,
                kbContext,
                resumeConstraints,
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
        `[strategist-research] Brief generated — fit="${result.data.overallFitRating}", ` +
        `verified=${result.data.verifiedMatches.length}, ` +
        `partial=${result.data.partialMatches.length}, ` +
        `gaps=${result.data.gaps.length}`,
    );

    return result;
}
