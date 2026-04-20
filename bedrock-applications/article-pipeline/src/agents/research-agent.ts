/**
 * @format
 * Research Agent — KB Retrieval, Complexity Analysis & Outline Generation
 *
 * First agent in the lean 3-agent pipeline. Analyses the raw draft,
 * retrieves context from the Bedrock Knowledge Base (Pinecone), classifies
 * content complexity, and produces a structured research brief.
 *
 * Uses Haiku 4.5 for cost efficiency — the research task is extraction
 * and analysis, not creative generation.
 *
 * Pipeline position: S3 Event → **Research** → Writer → QA → Review
 */

import {
    BedrockAgentRuntimeClient,
    RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

import { runAgent, parseJsonResponse, log } from '../../../shared/src/index.js';
import { RESEARCH_PERSONA_SYSTEM_PROMPT } from '../prompts/research-persona.js';
import type {
    AgentConfig,
    AgentResult,
    ComplexityAnalysis,
    ComplexityTier,
    KbPassage,
    PipelineContext,
    PipelineMode,
    ResearchResult,
    SeoResearch,
    SuggestedReference,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Research Agent model — set by CDK via RESEARCH_MODEL environment variable.
 * Must not be hardcoded to ensure the model registry remains the single source of truth.
 */
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
 * Falls back to RESEARCH_MODEL if not configured.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? RESEARCH_MODEL;

/** Maximum output tokens for Research Agent response */
const RESEARCH_MAX_TOKENS = 32768;

/** Thinking budget for Research Agent — moderate for analysis tasks */
const RESEARCH_THINKING_BUDGET = 4096;

/** Knowledge Base ID for Pinecone retrieval (empty = disabled) */
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID ?? '';

/** DynamoDB table for article metadata (used for previous version lookup) */
const TABLE_NAME = process.env.PIPELINE_TABLE_NAME ?? '';

/** Character threshold for KB-augmented mode detection */
const KB_AUGMENTED_THRESHOLD = 500;

/** Maximum KB passages to retrieve */
const MAX_KB_PASSAGES = 10;

/** Maximum characters to include from previous version content */
const PREVIOUS_VERSION_CONTENT_CAP = 3000;

// =============================================================================
// CLIENTS
// =============================================================================

const s3Client = new S3Client({});
const bedrockAgentClient = new BedrockAgentRuntimeClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// COMPLEXITY ANALYSIS
// =============================================================================

/**
 * Budget tokens per complexity tier.
 * These values are used by the Writer Agent for Adaptive Thinking.
 */
const TIER_BUDGETS: Record<ComplexityTier, number> = {
    LOW: 2_048,
    MID: 8_192,
    HIGH: 16_000,
};

/**
 * Analyse the raw markdown to classify its technical complexity.
 *
 * Signals inspected:
 * 1. Length — character count correlates with breadth of content
 * 2. Code density — ratio of fenced-code-block chars to total chars
 * 3. Code block count — number of distinct fenced blocks
 * 4. YAML/config blocks — yaml/yml/hcl code fences (IaC indicator)
 * 5. Heading depth — number of unique headings (structural complexity)
 *
 * @param markdown - The raw markdown content
 * @returns Complexity analysis with tier, budget, and signals
 */
export function analyseComplexity(markdown: string): ComplexityAnalysis {
    const charCount = markdown.length;

    // Count fenced code blocks and their total character length
    const codeBlockRegex = /```[\s\S]*?```/g;
    const codeBlocks = markdown.match(codeBlockRegex) ?? [];
    const codeBlockCount = codeBlocks.length;
    const codeChars = codeBlocks.reduce((sum, block) => sum + block.length, 0);
    const codeRatio = charCount > 0 ? codeChars / charCount : 0;

    // Count IaC-specific code fences
    const iacFenceRegex = /```(?:ya?ml|hcl|terraform|toml|dockerfile|Dockerfile)/gi;
    const yamlFrontmatterBlocks = (markdown.match(iacFenceRegex) ?? []).length;

    // Count unique headings
    const headingRegex = /^#{1,4}\s+.+$/gm;
    const uniqueHeadingCount = (markdown.match(headingRegex) ?? []).length;

    // Classification logic
    let tier: ComplexityTier;
    let reason: string;

    const isLong = charCount > 8_000;
    const isCodeHeavy = codeRatio > 0.3;
    const hasManyCodeBlocks = codeBlockCount >= 6;
    const hasIacBlocks = yamlFrontmatterBlocks >= 2;
    const isStructurallyComplex = uniqueHeadingCount >= 8;

    const heavySignals = [isLong && isCodeHeavy, hasManyCodeBlocks, hasIacBlocks, isStructurallyComplex];
    const heavyCount = heavySignals.filter(Boolean).length;

    if (heavyCount >= 2) {
        tier = 'HIGH';
        reason = `Dense technical content (${codeBlockCount} code blocks, ${(codeRatio * 100).toFixed(0)}% code, ${yamlFrontmatterBlocks} IaC fences, ${uniqueHeadingCount} headings)`;
    } else if (isLong || hasManyCodeBlocks || isCodeHeavy) {
        tier = 'MID';
        reason = `Moderate complexity (${codeBlockCount} code blocks, ${(codeRatio * 100).toFixed(0)}% code, ${charCount.toLocaleString()} chars)`;
    } else {
        tier = 'LOW';
        reason = `Light content (${codeBlockCount} code blocks, ${charCount.toLocaleString()} chars)`;
    }

    return {
        tier,
        budgetTokens: TIER_BUDGETS[tier],
        reason,
        signals: {
            charCount,
            codeBlockCount,
            codeRatio: Math.round(codeRatio * 100) / 100,
            yamlFrontmatterBlocks,
            uniqueHeadingCount,
        },
    };
}

// =============================================================================
// KNOWLEDGE BASE RETRIEVAL
// =============================================================================

/**
 * Query the Bedrock Knowledge Base (Pinecone) for relevant context.
 *
 * Uses the Bedrock Retrieve API to fetch passages that match
 * the draft content. Returns empty array if KB is disabled.
 *
 * @param query - The search query (draft content or brief)
 * @returns Array of KB passages with scores and source URIs
 */
async function queryKnowledgeBase(query: string): Promise<KbPassage[]> {
    if (!KNOWLEDGE_BASE_ID) {
        log('INFO', 'KB retrieval skipped — no KNOWLEDGE_BASE_ID configured', { agent: 'research' });
        return [];
    }

    log('INFO', 'Querying Knowledge Base', { agent: 'research', knowledgeBaseId: KNOWLEDGE_BASE_ID, queryLength: query.length });

    const command = new RetrieveCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        retrievalQuery: {
            text: query.substring(0, 1000), // KB query has a max length
        },
        retrievalConfiguration: {
            vectorSearchConfiguration: {
                numberOfResults: MAX_KB_PASSAGES,
            },
        },
    });

    const response = await bedrockAgentClient.send(command);
    const results = response.retrievalResults ?? [];

    const passages: KbPassage[] = results
        .filter((r) => r.content?.text)
        .map((r) => ({
            text: r.content!.text!,
            score: r.score ?? 0,
            sourceUri: r.location?.s3Location?.uri ?? 'unknown',
        }));

    log('INFO', 'KB retrieval complete', { agent: 'research', passageCount: passages.length, topScore: passages[0]?.score ?? null });

    return passages;
}

// =============================================================================
// S3 DRAFT READING
// =============================================================================

/**
 * Read the raw markdown draft from S3.
 *
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @returns Draft content as UTF-8 string
 * @throws Error if the S3 object body is empty
 */
async function readDraftFromS3(bucket: string, key: string): Promise<string> {
    const response = await s3Client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    }));

    if (!response.Body) {
        throw new Error(`S3 GetObject returned empty body for s3://${bucket}/${key}`);
    }

    return response.Body.transformToString('utf-8');
}

// =============================================================================
// AUTHOR DIRECTION EXTRACTION
// =============================================================================

/**
 * Extract the author's creative direction from the draft prompt.
 *
 * For short drafts (kb-augmented mode), the entire content is essentially
 * a prompt. This function extracts the instructional text — the part that
 * tells the Writer what kind of article to generate — by filtering out
 * headings, metadata lines, and structural markers.
 *
 * @param draftContent - Raw markdown draft
 * @returns Extracted author direction text
 */
function extractAuthorDirection(draftContent: string): string {
    const lines = draftContent.split('\n');
    let endIndex = lines.findIndex(line => line.trim().startsWith('```'));
    if (endIndex === -1) endIndex = lines.length;

    const directionLines = lines
        .slice(0, endIndex)
        .map(line => line.trim())
        .filter(trimmed => trimmed && !trimmed.startsWith('#') && !/^[A-Za-z-]+:\s/.test(trimmed));

    const direction = directionLines.join(' ').trim();
    log('INFO', 'Author direction extracted', { agent: 'research', directionLength: direction.length });
    return direction;
}

// =============================================================================
// PREVIOUS VERSION RETRIEVAL
// =============================================================================

/**
 * Fetch the previous version's MDX content from S3.
 *
 * Queries DynamoDB for the VERSION#v{n-1} record to find the S3
 * content reference, then reads the MDX file. Returns undefined
 * if this is the first version or if no previous content exists.
 *
 * @param ctx - Pipeline context with slug, version, bucket
 * @returns Previous version MDX content (capped), or undefined
 */
async function fetchPreviousVersionContent(
    ctx: PipelineContext,
): Promise<string | undefined> {
    if (ctx.version <= 1) {
        log('INFO', 'Version 1 — no previous version to fetch', { agent: 'research' });
        return undefined;
    }

    if (!TABLE_NAME) {
        log('WARN', 'PIPELINE_TABLE_NAME not set — skipping previous version lookup', { agent: 'research' });
        return undefined;
    }

    const previousVersion = ctx.version - 1;
    log('INFO', 'Fetching previous version content', { agent: 'research', previousVersion });

    try {
        const result = await ddbClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                pk: `ARTICLE#${ctx.slug}`,
                sk: `VERSION#v${previousVersion}`,
            },
            ProjectionExpression: 'contentRef',
        }));

        const contentRef = result.Item?.contentRef as string | undefined;
        if (!contentRef) {
            log('WARN', 'No contentRef found for previous version', { agent: 'research', previousVersion });
            return undefined;
        }

        // contentRef format: s3://bucket/review/v{n}/slug.mdx
        const s3Key = contentRef.replace(`s3://${ctx.bucket}/`, '');
        log('INFO', 'Reading previous version from S3', { agent: 'research', bucket: ctx.bucket, s3Key });

        const content = await readDraftFromS3(ctx.bucket, s3Key);
        const capped = content.substring(0, PREVIOUS_VERSION_CONTENT_CAP);

        log('INFO', 'Previous version loaded', { agent: 'research', originalLength: content.length, cappedLength: capped.length });

        return capped;
    } catch (error) {
        log('WARN', 'Failed to fetch previous version', { agent: 'research', error: String(error) });
        return undefined;
    }
}

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Research Agent.
 *
 * Includes the draft content and any KB context for analysis.
 *
 * @param draftContent - Raw markdown draft
 * @param kbPassages - Retrieved KB passages
 * @param mode - Pipeline mode (KB-augmented vs legacy)
 * @returns Formatted user message
 */
function buildResearchMessage(
    draftContent: string,
    kbPassages: KbPassage[],
    mode: PipelineMode,
): string {
    const parts: string[] = [
        `## Pipeline Mode: ${mode}`,
        ``,
        ...(kbPassages.length > 0
            ? [
                  `## Knowledge Base Context`,
                  `The following ${kbPassages.length} passages were retrieved from the project's infrastructure documentation:`,
                  ``,
                  ...kbPassages.flatMap((passage, i) => [
                      `### Passage ${i + 1} (score: ${passage.score.toFixed(3)}, source: ${passage.sourceUri})`,
                      passage.text,
                      ``
                  ])
              ]
            : []),
        `## Draft Content`,
        `--- BEGIN DRAFT ---`,
        draftContent,
        `--- END DRAFT ---`,
        ``,
        `Analyse this draft and return the JSON research brief.`
    ];

    return parts.join('\n');
}

// =============================================================================
// RESEARCH AGENT — SEO RESEARCH PARSER
// =============================================================================

/**
 * Safely extract SEO research data from the LLM response.
 *
 * Returns `undefined` when the LLM does not produce the `seoResearch`
 * field, making the feature gracefully optional for older prompts
 * or edge cases where the model omits it.
 *
 * @param parsed - Raw parsed JSON from the LLM research response
 * @returns Typed SeoResearch or undefined
 */
function parseSeoResearch(parsed: Record<string, unknown>): SeoResearch | undefined {
    const raw = parsed.seoResearch;
    if (!raw || typeof raw !== 'object') return undefined;

    const seo = raw as Record<string, unknown>;
    const primaryKeyword = typeof seo.primaryKeyword === 'string' ? seo.primaryKeyword : '';
    if (!primaryKeyword) return undefined;

    const secondaryKeywords = Array.isArray(seo.secondaryKeywords)
        ? seo.secondaryKeywords.filter((k): k is string => typeof k === 'string')
        : [];

    const suggestedReferences = Array.isArray(seo.suggestedReferences)
        ? seo.suggestedReferences
            .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
            .map((r): SuggestedReference => ({
                label: typeof r.label === 'string' ? r.label : '',
                url: typeof r.url === 'string' ? r.url : '',
                relevance: typeof r.relevance === 'string' ? r.relevance : '',
                usedInline: false, // Research Agent only suggests — Writer decides inline usage
            }))
            .filter((r) => r.label && r.url)
        : [];

    return { primaryKeyword, secondaryKeywords, suggestedReferences };
}

// =============================================================================
// RESEARCH AGENT EXECUTION
// =============================================================================

/**
 * Agent configuration for the Research Agent.
 */
const RESEARCH_CONFIG: AgentConfig = {
    agentName: 'research',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: RESEARCH_MAX_TOKENS,
    thinkingBudget: RESEARCH_THINKING_BUDGET,
    systemPrompt: RESEARCH_PERSONA_SYSTEM_PROMPT,
};

/**
 * Execute the Research Agent.
 *
 * Reads the draft from S3, queries the Knowledge Base, classifies
 * complexity, and generates a structured research brief.
 *
 * @param ctx - Pipeline context with bucket, sourceKey
 * @returns Research result with mode, complexity, KB passages, and outline
 */
export async function executeResearchAgent(
    ctx: PipelineContext,
): Promise<AgentResult<ResearchResult>> {
    // 1. Read draft from S3
    log('INFO', 'Reading draft from S3', { agent: 'research', bucket: ctx.bucket, sourceKey: ctx.sourceKey });
    const draftContent = await readDraftFromS3(ctx.bucket, ctx.sourceKey);

    // 2. Detect pipeline mode
    const mode: PipelineMode = draftContent.length <= KB_AUGMENTED_THRESHOLD
        ? 'kb-augmented'
        : 'legacy-transform';
    log('INFO', 'Pipeline mode detected', { agent: 'research', mode, draftLength: draftContent.length });

    // 3. Query Knowledge Base (for KB-augmented mode, or always for supplementary context)
    const kbPassages = await queryKnowledgeBase(draftContent);

    // 4. Perform local complexity analysis (fast, no LLM needed)
    const localComplexity = analyseComplexity(draftContent);
    log('INFO', 'Local complexity analysis complete', { agent: 'research', tier: localComplexity.tier, reason: localComplexity.reason });

    // 5. Build user message and run agent
    const userMessage = buildResearchMessage(draftContent, kbPassages, mode);

    // 6. Extract author direction from draft
    const authorDirection = extractAuthorDirection(draftContent);

    // 7. Fetch previous version content (for v2+ differentiation)
    const previousVersionContent = await fetchPreviousVersionContent(ctx);

    const result = await runAgent<ResearchResult>({
        config: RESEARCH_CONFIG,
        userMessage,
        parseResponse: (text) => {
            const parsed = parseJsonResponse<Record<string, unknown>>(text, 'research');

            // Merge local complexity analysis with LLM-generated outline
            const seoResearch = parseSeoResearch(parsed);
            return {
                mode,
                draftContent,
                complexity: localComplexity, // Use local analysis (deterministic)
                kbPassages,
                outline: Array.isArray(parsed.outline) ? parsed.outline : [],
                technicalFacts: Array.isArray(parsed.technicalFacts) ? parsed.technicalFacts : [],
                suggestedTitle: typeof parsed.suggestedTitle === 'string'
                    ? parsed.suggestedTitle
                    : 'Untitled Article',
                suggestedTags: Array.isArray(parsed.suggestedTags) ? parsed.suggestedTags : [],
                authorDirection,
                previousVersionContent,
                seoResearch,
            } as ResearchResult;
        },
        pipelineContext: ctx,
    });

    log('INFO', 'Research brief generated', {
        agent: 'research',
        suggestedTitle: result.data.suggestedTitle,
        sectionCount: result.data.outline.length,
        factCount: result.data.technicalFacts.length,
    });

    return result;
}
