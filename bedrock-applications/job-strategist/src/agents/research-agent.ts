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
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

import { runAgent, parseJsonResponse, InputSanitiser, log } from '../../../shared/src/index.js';
import type { PiiPattern } from '../../../shared/src/index.js';
import { formatResumeForPrompt } from '../services/resume-service.js';
import { RESEARCH_PERSONA_SYSTEM_PROMPT } from '../prompts/research-persona.js';

/**
 * PII patterns specific to job description inputs.
 * Flags (warns) without redacting — JDs may legitimately contain recruiter contact info.
 */
const STRATEGIST_PII_PATTERNS: ReadonlyArray<PiiPattern> = [
    { regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, label: 'phone-number' },
    { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: 'email-address' },
    { regex: /\b\d{3}-\d{2}-\d{4}\b/g, label: 'ssn-like-pattern' },
];

/** Module-scoped sanitiser with strategist-specific length and PII config */
const inputSanitiser = new InputSanitiser({
    minLength: 50,
    maxLength: 50_000,
    piiPatterns: STRATEGIST_PII_PATTERNS,
});
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

/** Maximum output tokens — must exceed thinkingBudget + expected JSON output.
 *  thinkingBudget=4096 + research JSON brief ~8-12K tokens = 16384 minimum. */
const RESEARCH_MAX_TOKENS = 16000;

/** Thinking budget for analysis tasks */
const RESEARCH_THINKING_BUDGET = 4096;

/** Knowledge Base ID for Pinecone retrieval */
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID ?? '';

/** wiki-mcp base URL — deterministic constraint retrieval (falls back to Pinecone if unset) */
const WIKI_MCP_URL = process.env.WIKI_MCP_URL ?? '';

/**
 * SSM path for the wiki-mcp BasicAuth SecureString (e.g. /wiki-mcp/basicauth-header).
 * Value is fetched at runtime — CloudFormation cannot resolve ssm-secure refs in Lambda env vars.
 */
const WIKI_MCP_AUTH_SSM_PATH = process.env.WIKI_MCP_AUTH_SSM_PATH ?? '';

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

    log('INFO', 'Querying KB', { agent: 'strategist-research', queryPreview: query.substring(0, 80) });

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

    log('INFO', 'Deduplicated passages', { agent: 'strategist-research', total: passages.length, unique: unique.length });

    return unique.length > 0 ? unique.join('\n\n---\n\n') : '';
}

// Module-level cache — fetched once per Lambda execution context.
let cachedWikiMcpAuth = '';

/**
 * Resolve the wiki-mcp BasicAuth header.
 *
 * Fetches the SSM SecureString at `/wiki-mcp/basicauth-header` on first call
 * and caches the result for the lifetime of the Lambda execution context.
 * Returns empty string when WIKI_MCP_AUTH_SSM_PATH is not configured.
 */
async function resolveWikiMcpAuth(): Promise<string> {
    if (cachedWikiMcpAuth) return cachedWikiMcpAuth;
    if (!WIKI_MCP_AUTH_SSM_PATH) return '';

    const ssmClient = new SSMClient({});
    const resp = await ssmClient.send(
        new GetParameterCommand({ Name: WIKI_MCP_AUTH_SSM_PATH, WithDecryption: true }),
    );
    cachedWikiMcpAuth = resp.Parameter?.Value ?? '';
    return cachedWikiMcpAuth;
}

/**
 * Fetch resume constraints from the wiki-mcp REST API.
 *
 * Calls GET /api/constraints which returns combined content from:
 *   - resume/agent-guide   — hard rules, confidence thresholds, ATS rules, banned verbs
 *   - resume/gap-awareness — what NOT to claim; absent/partial concepts with safe framing
 *   - resume/voice-library — authentic phrase anchors, banned AI terms, sentence variation
 *
 * Uses the REST endpoint (not MCP Streamable HTTP) as the server was designed for Lambda
 * to call /api/constraints directly — the /mcp SSE stream is for Claude Desktop/Code.
 *
 * @returns Combined constraint pages as plain text, or empty string if wiki-mcp is not configured
 */
async function getWikiMcpConstraints(): Promise<string> {
    const authHeader = await resolveWikiMcpAuth();
    if (!WIKI_MCP_URL || !authHeader) {
        return '';
    }
    log('INFO', 'Fetching resume constraints from wiki-mcp REST API', { agent: 'strategist-research' });
    const base = WIKI_MCP_URL.endsWith('/') ? WIKI_MCP_URL : `${WIKI_MCP_URL}/`;
    const url = new URL('api/constraints', base);
    try {
        const response = await fetch(url.toString(), {
            headers: { Authorization: authHeader },
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
            log('WARN', 'wiki-mcp /api/constraints returned non-OK status — continuing without constraints', {
                agent: 'strategist-research', statusCode: response.status,
            });
            return '';
        }
        // TypeScript wiki-mcp returns JSON { content: string } — extract the content field
        const json = await response.json() as { content?: string };
        const text = json.content ?? '';
        log('INFO', 'wiki-mcp constraints fetched', {
            agent: 'strategist-research', sizeKb: (text.length / 1024).toFixed(1),
        });
        return text;
    } catch (err) {
        log('WARN', 'wiki-mcp fetch failed — continuing without constraints', {
            agent: 'strategist-research', error: (err as Error).message,
        });
        return '';
    }
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
            '## PATH B — Uploaded Resume (FORMATTING REFERENCE ONLY)',
            '',
            '⚠️  CONTENT PROHIBITION — NEVER VIOLATE:',
            'Do NOT copy, paraphrase, or derive any content from this document.',
            '',
            'PERMITTED uses of this document:',
            '  • Section ordering preference',
            '  • Header and contact block format (name, email, location, links)',
            '',
            'PROHIBITED uses — applying any of these is a fabrication error:',
            '  • Any bullet point, phrase, or sentence from this document',
            '  • Summary text, project descriptions, or skill selections',
            '  • Using the skills list to decide what to include or exclude',
            '  • Paraphrasing or reformulating any text from this document',
            '',
            'If a section exists here but has no KB evidence below, leave that section EMPTY.',
            'If this document\'s structure conflicts with archetype section ordering, the ARCHETYPE WINS.',
            '--- BEGIN FORMATTING REFERENCE ---',
            formatResumeForPrompt(resumeData),
            '--- END FORMATTING REFERENCE ---',
            '',
        );
    } else {
        sections.push(
            '## PATH A — KB-Only Generation (no resume provided)',
            'Generate all content entirely from the Knowledge Base evidence below.',
            'No structural constraints from any uploaded document — this is the preferred default.',
            'Do NOT reference or imply any prior resume draft — there is none.',
            'Apply confidence thresholds (STRONG/PARTIAL/ABSENT) as normal.',
            '',
        );
    }

    if (kbContext) {
        sections.push(
            '## Knowledge Base — Portfolio & Project Evidence',
            'The following passages were retrieved from the candidate\'s portfolio documentation.',
            resumeData
                ? 'These are the SOLE CONTENT SOURCE. The formatting reference above contributes no content.'
                : 'Use these as the SOLE evidence source for all skill classifications and bullet generation.',
            'KB constraint passages (containing "NEVER", "ABSENT", "PROHIBITED") are absolute overrides.',
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
 * 2. Queries Pinecone (3 factual) + wiki-mcp (constraints) in parallel
 *    — falls back to 3 Pinecone constraint queries when wiki-mcp is not configured
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
    log('INFO', 'Analysing JD', { agent: 'strategist-research', pipelineId: ctx.pipelineId, targetRole: ctx.targetRole });
    const { sanitised, warnings, injectionDetected } = inputSanitiser.sanitiseWithWarnings(ctx.jobDescription);

    if (injectionDetected) {
        log('WARN', 'Injection attempt detected — proceeding with sanitised input', { agent: 'strategist-research' });
    }
    for (const warning of warnings) {
        log('WARN', warning, { agent: 'strategist-research' });
    }

    // 2. Query Knowledge Base + wiki-mcp constraints in parallel
    //
    //    Factual (Pinecone): 3 semantic queries for portfolio evidence & skill signals
    //    Constraints (wiki-mcp): single deterministic GET /api/constraints
    //      → agent-guide (hard rules) + gap-awareness (what NOT to claim)
    //        + voice-library (authentic language anchors)
    //
    //    Fallback: if wiki-mcp is not configured, run 3 Pinecone constraint queries instead
    let kbContext = '';
    let resumeConstraints = '';

    const hasKb = Boolean(KNOWLEDGE_BASE_ID);
    const hasWikiMcp = Boolean(WIKI_MCP_URL && WIKI_MCP_AUTH_SSM_PATH);

    if (hasKb || hasWikiMcp) {
        // Factual KB queries + wiki-mcp constraint fetch — all in parallel
        const [factual1, factual2, factual3, factual4, wikiConstraints] = await Promise.all([
            // Query 1 — full JD text: surfaces skill/tech matches from across the KB
            hasKb ? querySingleKb(sanitised.substring(0, 1000)) : Promise.resolve([]),
            // Query 2 — JD tail + experience signal: surfaces role-relevant work history
            hasKb ? querySingleKb(`professional experience skills qualifications ${sanitised.substring(500, 1000)}`) : Promise.resolve([]),
            // Query 3 — JD-aware project query: surfaces project templates matching this role
            hasKb ? querySingleKb(`portfolio project implementation achievements ${sanitised.substring(0, 500)}`) : Promise.resolve([]),
            // Query 4 — DORA metrics and outcome measurements: ensures every bullet can be
            // grounded in a concrete outcome (lead time, MTTR, CFR, deployment frequency).
            // Without this query the agent sees technical inventory but no outcome numbers.
            hasKb ? querySingleKb('DORA metrics lead time MTTR change failure rate deployment frequency outcome measurement pipeline performance') : Promise.resolve([]),
            getWikiMcpConstraints(),   // '' when WIKI_MCP_URL / WIKI_MCP_AUTH not set
        ]);

        // Factual context — portfolio evidence for achievement bullet verification
        const allFactualPassages = [...factual1, ...factual2, ...factual3, ...factual4];
        kbContext = deduplicatePassages(allFactualPassages);

        resumeConstraints = wikiConstraints;

        // Fallback: wiki-mcp not configured → retrieve constraints from Pinecone instead
        if (!resumeConstraints && hasKb) {
            log('INFO', 'wiki-mcp not configured — falling back to Pinecone for constraints', { agent: 'strategist-research' });
            const [agentRules, gapBoundaries, voiceLibrary] = await Promise.all([
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
            const allConstraintPassages = [...agentRules, ...gapBoundaries, ...voiceLibrary];
            resumeConstraints = deduplicatePassages(allConstraintPassages);
        }

        log('INFO', 'Retrieval complete', {
            agent: 'strategist-research',
            factualSizeKb: kbContext.length > 0 ? (kbContext.length / 1024).toFixed(1) : 'empty',
            constraintsSizeKb: resumeConstraints.length > 0 ? (resumeConstraints.length / 1024).toFixed(1) : 'empty',
            constraintSource: hasWikiMcp ? 'wiki-mcp' : 'pinecone',
        });
    } else {
        log('INFO', 'Retrieval skipped — no KNOWLEDGE_BASE_ID or WIKI_MCP_URL configured', { agent: 'strategist-research' });
    }

    // 3. Read resume from pipeline context (fetched at trigger time)
    const resumeData = ctx.resumeData;
    if (!resumeData) {
        log('INFO', 'No resume data — build-from-scratch mode', { agent: 'strategist-research' });
    } else {
        log('INFO', 'Resume loaded from context', { agent: 'strategist-research', profileName: resumeData.profile.name });
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
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
        },
    });

    log('INFO', 'Brief generated', {
        agent: 'strategist-research',
        fitRating: result.data.overallFitRating,
        verified: result.data.verifiedMatches.length,
        partial: result.data.partialMatches.length,
        gaps: result.data.gaps.length,
    });

    return result;
}
