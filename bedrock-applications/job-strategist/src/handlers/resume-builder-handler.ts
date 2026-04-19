/**
 * @format
 * Resume Builder Handler — Step Functions Stage (Analysis Pipeline)
 *
 * Lambda handler invoked by Step Functions after the Strategist Agent.
 *
 * Option A architecture: the Strategist Agent produces the complete
 * tailored StructuredResumeData JSON in Phase 4 (<tailored_resume_json>).
 * This handler validates that JSON and persists it to DynamoDB directly —
 * no LLM patch-application step. The Resume Builder Agent is not invoked.
 *
 * Input:  { context, research, analysis }
 * Output: { context, research, analysis, tailoredResume }
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { StructuredResumeDataSchema } from '../schemas/resume-data.schema.js';
import { AgentHandlerEnvSchema } from '../schemas/environment.schema.js';
import type {
    ResumeBuilderHandlerInput,
    ResumeBuilderHandlerOutput,
    TailoredResumeResult,
} from '../../../shared/src/index.js';

// =============================================================================
// ENVIRONMENT VALIDATION (fail-fast at cold start)
// =============================================================================

const env = AgentHandlerEnvSchema.parse(process.env);

// =============================================================================
// CONFIGURATION
// =============================================================================

/** DynamoDB table for job application tracking */
const TABLE_NAME = env.TABLE_NAME;

// =============================================================================
// CLIENTS
// =============================================================================

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for building and persisting the tailored resume.
 *
 * Writes:
 * 1. TAILORED_RESUME#<pipelineId> record with the full tailored StructuredResumeData
 * 2. Updated METADATA record with tailoredResumeAvailable flag
 *
 * @param event - Step Functions input with research and analysis results
 * @returns Updated pipeline output including tailored resume
 */
export const handler = async (
    event: ResumeBuilderHandlerInput,
): Promise<ResumeBuilderHandlerOutput> => {
    if (!event?.context?.pipelineId) {
        throw new Error(
            '[resume-builder] Invalid Step Functions event: "context.pipelineId" is missing. ' +
            'This handler must be invoked by the Analysis State Machine, not directly.',
        );
    }

    const { context, research, analysis } = event;
    const now = new Date().toISOString();

    // ── Option A: use complete tailored resume from Strategist Phase 4 ───────
    // The Strategist Agent produces the authoritative StructuredResumeData JSON
    // in <tailored_resume_json>. No LLM patch application occurs here.
    // ─────────────────────────────────────────────────────────────────────────
    const tailoredResumeData = analysis.data.tailoredResumeData ?? null;

    if (!tailoredResumeData) {
        console.warn(
            `[resume-builder] Pipeline ${context.pipelineId} — ` +
            `no tailored_resume_json from Strategist (build-from-scratch or legacy run). Skipping.`,
        );
        return {
            context: { ...context, resumeData: null },
            research,
            analysis,
            tailoredResume: null,
        };
    }

    // Validate the Strategist's JSON against the resume schema before persisting.
    // This catches schema drift between Strategist output and the Zod contract.
    const validated = StructuredResumeDataSchema.safeParse(tailoredResumeData);
    if (!validated.success) {
        console.error(
            `[resume-builder] Pipeline ${context.pipelineId} — ` +
            `tailored_resume_json failed schema validation: ${validated.error.message}. ` +
            `Skipping persistence to prevent corrupt data.`,
        );
        return {
            context: { ...context, resumeData: null },
            research,
            analysis,
            tailoredResume: null,
        };
    }

    const archetype = analysis.data.archetypeSelection?.selectedArchetype ?? 'unknown archetype';
    const changesSummary = `Strategist (${archetype}) produced complete tailored resume — no patch step`;

    console.log(
        `[resume-builder] Pipeline ${context.pipelineId} ` +
        `— persisting Strategist-authored resume for "${context.targetRole}" (${archetype})`,
    );

    const tailoredResumeResult: TailoredResumeResult = {
        tailoredResume: validated.data,
        changesSummary,
        additionsApplied: 0,   // Deprecated — Strategist owns the full output
        reframesApplied: 0,    // Deprecated — Strategist owns the full output
        eslCorrectionsApplied: 0, // Deprecated — Strategist owns the full output
    };

    if (TABLE_NAME) {
        // 1. Store tailored resume — versioned by pipelineId
        console.log(`[resume-builder] Storing TAILORED_RESUME#${context.pipelineId}`);
        await ddbClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: `APPLICATION#${context.applicationSlug}`,
                sk: `TAILORED_RESUME#${context.pipelineId}`,
                tailoredResume: tailoredResumeResult.tailoredResume,
                changesSummary: tailoredResumeResult.changesSummary,
                archetype,
                archetypeId: analysis.data.archetypeSelection?.archetypeId ?? null,
                archetypeGapDetected: analysis.data.archetypeSelection?.archetypeGapDetected ?? null,
                createdAt: now,
                environment: context.environment,
            },
        }));

        // 2. Update METADATA with tailored resume availability flag
        console.log(`[resume-builder] Updating METADATA — tailoredResumeAvailable=true`);
        await ddbClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
                pk: `APPLICATION#${context.applicationSlug}`,
                sk: 'METADATA',
            },
            UpdateExpression: 'SET tailoredResumeAvailable = :available, updatedAt = :now',
            ExpressionAttributeValues: {
                ':available': true,
                ':now': now,
            },
        }));
    }

    // ─── Payload trimming ─────────────────────────────────────────
    // resumeData consumed — strip from context to stay under 256KB.
    // tailoredResume already persisted to DDB — no need to carry in SF payload.
    // ──────────────────────────────────────────────────────────────

    console.log(
        `[resume-builder] Pipeline ${context.pipelineId} — tailored resume persisted. ` +
        `resumeData stripped from Step Functions payload.`,
    );

    return {
        context: { ...context, resumeData: null },
        research,
        analysis,
        tailoredResume: null, // Already in DDB
    };
};
