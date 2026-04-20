/**
 * @format
 * Writer Agent — Full MDX Article Generation
 *
 * Second agent in the lean 3-agent pipeline. Takes the structured
 * research brief from the Research Agent and generates a complete
 * MDX article with frontmatter, components, and visual directives.
 *
 * Uses Sonnet 4.6 for creative writing — the Writer task requires
 * top-tier reasoning, narrative voice, and technical accuracy.
 *
 * Pipeline position: Research → **Writer** → QA → Review
 */

import { BaseAgent, parseJsonResponse, log } from '../../../shared/src/index.js';
import { BLOG_PERSONA_SYSTEM_PROMPT } from '../prompts/blog-persona.js';
import type {
    AgentConfig,
    AgentResult,
    ArticleMetadata,
    PipelineContext,
    ResearchResult,
    ShotListItem,
    SuggestedReference,
    WriterResult,
} from '../../../shared/src/index.js';

// =============================================================================
// INPUT TYPE
// =============================================================================

/**
 * Typed input for the Writer Agent.
 *
 * Contains the Research Agent's output which provides the
 * structured brief, complexity classification, and KB context.
 */
export interface WriterAgentInput {
    /** Research Agent's structured output */
    readonly research: ResearchResult;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Writer Agent model — uses Sonnet 4.6 for creative generation.
 * Falls back to cross-region Sonnet profile if not set.
 */
const WRITER_MODEL = process.env.FOUNDATION_MODEL ?? 'eu.anthropic.claude-sonnet-4-6-20260310-v1:0';

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? WRITER_MODEL;

/** Maximum output tokens for Writer Agent response (full MDX articles need substantial headroom) */
const WRITER_MAX_TOKENS = Number.parseInt(process.env.MAX_TOKENS ?? '65536', 10);

/** Default thinking budget (overridden by Research Agent complexity tier) */
const DEFAULT_THINKING_BUDGET = Number.parseInt(process.env.THINKING_BUDGET_TOKENS ?? '16000', 10);

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Writer Agent.
 *
 * Provides the Writer with the Research Agent's structured brief,
 * including KB context, complexity classification, and proposed outline.
 *
 * @param research - Research result from the Research Agent
 * @param retryAttempt - Current retry attempt (0-based)
 * @returns Formatted user message
 */
function buildContextSection(research: ResearchResult, retryAttempt: number, version: number): string[] {
    return [
        ...(retryAttempt > 0
            ? [
                  ``,
                  `> ⚠️ This is retry attempt ${retryAttempt}. The previous version did not pass QA.`,
                  `> Pay extra attention to technical accuracy and code correctness.`
              ]
            : []),
        ...(research.authorDirection
            ? [
                  ``,
                  `## ⚡ Author's Direction`,
                  `> This is the author's specific creative direction for this article.`,
                  `> Your article MUST directly address these instructions.`,
                  `> Do NOT let KB context or standard templates override this direction.`,
                  ``,
                  research.authorDirection
              ]
            : []),
        ...(research.previousVersionContent
            ? [
                  ``,
                  `## 🔄 Previous Version (v${version - 1})`,
                  `> A previous version of this article already exists. The author has submitted`,
                  `> a NEW prompt with DIFFERENT creative direction (see "Author's Direction" above).`,
                  `> You MUST generate a substantially different article that addresses the new direction.`,
                  `> Do NOT simply rephrase, extend, or lightly edit the previous version.`,
                  ``,
                  `--- BEGIN PREVIOUS VERSION ---`,
                  research.previousVersionContent,
                  `--- END PREVIOUS VERSION ---`
              ]
            : []),
        ...(research.kbPassages.length > 0
            ? [
                  ``,
                  `## Knowledge Base Context`,
                  `The following passages are from the project's real infrastructure documentation:`,
                  ``,
                  ...research.kbPassages.flatMap((passage, i) => [
                      `### KB Passage ${i + 1} (relevance: ${passage.score.toFixed(3)})`,
                      passage.text,
                      ``
                  ])
              ]
            : [])
    ];
}

function buildOutlineAndFactsSection(research: ResearchResult): string[] {
    return [
        ...(research.outline.length > 0
            ? [
                  ``,
                  `## Proposed Article Outline`,
                  `The Research Agent suggests the following structure:`,
                  ``,
                  ...research.outline.flatMap(section => {
                      const visualMarker = section.needsVisual ? ' 📊' : '';
                      const heading = `- **${section.heading}** (~${section.wordBudget} words)${visualMarker}`;
                      return section.keyPoints.length > 0
                          ? [heading, ...section.keyPoints.map(point => `  - ${point}`)]
                          : [heading];
                  })
              ]
            : []),
        ...(research.technicalFacts.length > 0
            ? [
                  ``,
                  `## Verified Technical Facts`,
                  `These facts were extracted from the draft and KB. Preserve them accurately:`,
                  ``,
                  ...research.technicalFacts.map(fact => `- ${fact}`)
              ]
            : [])
    ];
}

function buildSeoSection(research: ResearchResult): string[] {
    if (!research.seoResearch) {
        return [];
    }

    return [
        ``,
        `## SEO Research Brief`,
        `- Primary Keyword: ${research.seoResearch.primaryKeyword}`,
        ...(research.seoResearch.secondaryKeywords.length > 0
            ? [`- Secondary Keywords: ${research.seoResearch.secondaryKeywords.join(', ')}`]
            : []),
        ...(research.seoResearch.suggestedReferences.length > 0
            ? [
                  ``,
                  `### Suggested Authoritative References`,
                  `The Research Agent identified these external links for credibility:`,
                  ...research.seoResearch.suggestedReferences.flatMap(ref =>
                      ref.relevance
                          ? [`- **${ref.label}**: [${ref.url}](${ref.url})`, `  *Relevance: ${ref.relevance}*`]
                          : [`- **${ref.label}**: [${ref.url}](${ref.url})`]
                  )
              ]
            : [])
    ];
}

function buildWriterMessage(
    research: ResearchResult,
    retryAttempt: number,
    version: number,
): string {
    const parts: string[] = [
        `## Content Generation Request`,
        `- Pipeline Mode: ${research.mode}`,
        `- Complexity: ${research.complexity.tier} — ${research.complexity.reason}`,
        `- Suggested Title: ${research.suggestedTitle}`,
        `- Suggested Tags: ${research.suggestedTags.join(', ')}`,
        ...buildContextSection(research, retryAttempt, version),
        ...buildOutlineAndFactsSection(research),
        ...buildSeoSection(research),
        ``,
        `## Source Draft`,
        `--- BEGIN DRAFT ---`,
        research.draftContent,
        `--- END DRAFT ---`,
        ``,
        `Generate the complete MDX article. Return the JSON output as specified in your system prompt.`
    ];

    return parts.join('\n');
}

// =============================================================================
// RESPONSE PARSER
// =============================================================================

/**
 * Parse the Writer Agent's JSON response into a typed WriterResult.
 *
 * @param responseText - Raw text response from Bedrock
 * @returns Validated WriterResult
 * @throws Error if required fields are missing
 */
function parseArticleMetadata(metadata: Record<string, unknown>): ArticleMetadata {
    return {
        title: typeof metadata.title === 'string' ? metadata.title : 'Untitled Article',
        description: typeof metadata.description === 'string' ? metadata.description : '',
        tags: Array.isArray(metadata.tags) ? metadata.tags.filter((t): t is string => typeof t === 'string') : [],
        slug: typeof metadata.slug === 'string' ? metadata.slug : 'untitled',
        publishDate: typeof metadata.publishDate === 'string' ? metadata.publishDate : new Date().toISOString().split('T')[0],
        readingTime: typeof metadata.readingTime === 'number' ? metadata.readingTime : 8,
        category: typeof metadata.category === 'string' ? metadata.category : 'DevOps',
        aiSummary: typeof metadata.aiSummary === 'string' ? metadata.aiSummary : '',
        technicalConfidence: typeof metadata.technicalConfidence === 'number'
            ? Math.max(0, Math.min(100, metadata.technicalConfidence))
            : 70,
        skillsDemonstrated: Array.isArray(metadata.skillsDemonstrated)
            ? metadata.skillsDemonstrated.filter((s): s is string => typeof s === 'string')
            : [],
        processingNote: typeof metadata.processingNote === 'string' ? metadata.processingNote : '',
        primaryKeyword: typeof metadata.primaryKeyword === 'string' ? metadata.primaryKeyword : undefined,
        secondaryKeywords: Array.isArray(metadata.secondaryKeywords)
            ? metadata.secondaryKeywords.filter((k): k is string => typeof k === 'string')
            : undefined,
    };
}

function parseShotListArray(rawShotList: unknown[]): ShotListItem[] {
    return rawShotList
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
            id: typeof item.id === 'string' ? item.id : 'unknown',
            type: ['diagram', 'screenshot', 'hero'].includes(item.type as string)
                ? (item.type as 'diagram' | 'screenshot' | 'hero')
                : 'diagram',
            instruction: typeof item.instruction === 'string' ? item.instruction : '',
            context: typeof item.context === 'string' ? item.context : '',
        }));
}

function parseSuggestedReferencesArray(rawRefs: unknown[]): SuggestedReference[] {
    return rawRefs
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({
            label: typeof r.label === 'string' ? r.label : '',
            url: typeof r.url === 'string' ? r.url : '',
            relevance: typeof r.relevance === 'string' ? r.relevance : '',
            usedInline: typeof r.usedInline === 'boolean' ? r.usedInline : false,
        }))
        .filter((r) => r.label && r.url);
}

/**
 * Parse the Writer Agent's JSON response into a typed WriterResult.
 *
 * @param responseText - Raw text response from Bedrock
 * @returns Validated WriterResult
 * @throws Error if required fields are missing
 */
function parseWriterResponse(responseText: string): WriterResult {
    const parsed = parseJsonResponse<Record<string, unknown>>(responseText, 'writer');

    // Validate required fields
    if (typeof parsed.content !== 'string' || parsed.content.length === 0) {
        throw new TypeError('Writer Agent: Missing or empty "content" in response');
    }

    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (!metadata || typeof metadata !== 'object') {
        throw new TypeError('Writer Agent: Missing "metadata" object in response');
    }

    const validatedMetadata = parseArticleMetadata(metadata);
    const rawShotList = Array.isArray(parsed.shotList) ? parsed.shotList : [];
    const shotList = parseShotListArray(rawShotList);
    const rawRefs = Array.isArray(parsed.suggestedReferences) ? parsed.suggestedReferences : [];
    const suggestedReferences = parseSuggestedReferencesArray(rawRefs);

    return {
        content: parsed.content,
        metadata: validatedMetadata,
        shotList,
        suggestedReferences: suggestedReferences.length > 0 ? suggestedReferences : undefined,
    };
}

// =============================================================================
// WRITER AGENT CLASS
// =============================================================================

/**
 * Writer Agent — MDX article generation via Bedrock Converse API.
 *
 * Extends {@link BaseAgent} to encapsulate the Writer's lifecycle:
 * - Dynamic thinking budget based on Research Agent's complexity tier
 * - Full MDX article generation with frontmatter and visual directives
 * - Structured metadata and shot list extraction
 *
 * @example
 * ```typescript
 * const result = await writerAgent.execute({ research }, ctx);
 * ```
 */
class WriterAgent extends BaseAgent<WriterAgentInput, WriterResult, PipelineContext> {
    protected readonly agentName = 'writer' as const;

    /**
     * Build writer configuration with dynamic thinking budget.
     *
     * The thinking budget is capped at {@link DEFAULT_THINKING_BUDGET}
     * but scaled down for simpler content based on the Research Agent's
     * complexity classification.
     *
     * @param input - Writer input with research complexity tier
     * @returns Agent config with adaptive thinking budget
     */
    protected getConfig(input: WriterAgentInput): AgentConfig {
        const thinkingBudget = Math.min(
            input.research.complexity.budgetTokens,
            DEFAULT_THINKING_BUDGET,
        );

        return {
            agentName: 'writer',
            modelId: EFFECTIVE_MODEL_ID,
            maxTokens: WRITER_MAX_TOKENS,
            thinkingBudget,
            systemPrompt: BLOG_PERSONA_SYSTEM_PROMPT,
        };
    }

    /**
     * Build the user message from the research brief.
     *
     * @param input - Writer input with research result
     * @param ctx   - Pipeline context for retry/version info
     * @returns Formatted user message for Bedrock
     */
    protected buildUserMessage(input: WriterAgentInput, ctx: PipelineContext): string {
        return buildWriterMessage(input.research, ctx.retryAttempt, ctx.version);
    }

    /**
     * Parse the raw LLM text into a typed WriterResult.
     *
     * @param responseText - Raw text response from Bedrock
     * @returns Validated WriterResult
     */
    protected parseResponse(responseText: string): WriterResult {
        return parseWriterResponse(responseText);
    }

    /**
     * Pre-execution hook — logs complexity and retry context.
     *
     * @param input - Writer input
     * @param ctx   - Pipeline context
     */
    protected override beforeExecute(input: WriterAgentInput, ctx: PipelineContext): void {
        const thinkingBudget = Math.min(
            input.research.complexity.budgetTokens,
            DEFAULT_THINKING_BUDGET,
        );

        log('INFO', 'Generating article', {
            agent: 'writer',
            complexity: input.research.complexity.tier,
            thinkingBudget,
            retryAttempt: ctx.retryAttempt,
        });
    }

    /**
     * Post-execution hook — logs article metadata.
     *
     * @param result - Writer agent result
     */
    protected override afterExecute(result: AgentResult<WriterResult>): void {
        log('INFO', 'Article generated', {
            agent: 'writer',
            title: result.data.metadata.title,
            slug: result.data.metadata.slug,
            readingTime: result.data.metadata.readingTime,
            confidence: result.data.metadata.technicalConfidence,
            shotListCount: result.data.shotList.length,
        });
    }
}

/** Module-level singleton — re-used across Lambda invocations. */
const writerAgent = new WriterAgent();

/** Export the agent instance for direct usage. */
export { writerAgent, WriterAgent };

/**
 * Execute the Writer Agent.
 *
 * Backward-compatible wrapper that delegates to the
 * {@link WriterAgent} class instance. Handlers can use this
 * without any import path changes.
 *
 * @param ctx - Pipeline context
 * @param research - Research result from the first agent
 * @returns Writer result with MDX content, metadata, and shot list
 */
export async function executeWriterAgent(
    ctx: PipelineContext,
    research: ResearchResult,
): Promise<AgentResult<WriterResult>> {
    return writerAgent.execute({ research }, ctx);
}
