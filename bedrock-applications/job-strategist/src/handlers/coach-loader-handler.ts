/**
 * @format
 * Coach Loader Handler — Step Functions Entry Stage (Coaching Pipeline)
 *
 * Lambda handler invoked by Step Functions as the first stage of the
 * coaching pipeline. Loads the latest ANALYSIS# record from DynamoDB
 * so the Coach Agent can use it for stage-specific interview preparation.
 *
 * Security: DynamoDB record fields are validated via Zod schema —
 * no unsafe `as` type assertions on external data.
 *
 * Input:  { context: StrategistPipelineContext }
 * Output: { context, analysis }
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import type {
    StrategistCoachLoaderInput,
    StrategistCoachHandlerInput,
    AgentResult,
    StrategistAnalysisResult,
} from '../../../shared/src/index.js';

import { log } from '../../../shared/src/index.js';

import { AnalysisRecordSchema } from '../schemas/dynamo-record.schema.js';
import { DdbHandlerEnvSchema } from '../schemas/environment.schema.js';

// =============================================================================
// ENVIRONMENT VALIDATION (FAIL-FAST ON COLD START)
// =============================================================================

const env = DdbHandlerEnvSchema.parse(process.env);

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
 * Lambda handler for loading existing analysis from DynamoDB.
 *
 * Queries APPLICATION#<slug> for the latest ANALYSIS# sort key
 * (newest first by pipeline execution ID timestamp) and reconstructs
 * the StrategistAnalysisResult for the Coach Agent.
 *
 * All DynamoDB record fields are validated via Zod schema — no
 * unsafe `record['field'] as Type` casts.
 *
 * @param event - Step Functions input with pipeline context
 * @returns Context plus the loaded analysis, ready for the Coach Handler
 * @throws Error if no analysis exists for the given application slug
 */
export const handler = async (
    event: StrategistCoachLoaderInput,
): Promise<StrategistCoachHandlerInput> => {
    if (!event?.context?.pipelineId) {
        throw new Error(
            '[coach-loader] Invalid Step Functions event: "context.pipelineId" is missing. ' +
            'This handler must be invoked by the Coaching State Machine, not directly.',
        );
    }

    const { context } = event;

    log('INFO', 'Loading analysis', {
        handler: 'coach-loader', pipelineId: context.pipelineId,
        applicationSlug: context.applicationSlug,
    });

    // Query for the latest ANALYSIS# record (newest first)
    const result = await ddbClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
            ':pk': `APPLICATION#${context.applicationSlug}`,
            ':prefix': 'ANALYSIS#',
        },
        ScanIndexForward: false,  // Newest first (lexicographic — timestamp-based IDs)
        Limit: 1,
    }));

    if (!result.Items?.length) {
        throw new Error(
            `[coach-loader] No analysis found for APPLICATION#${context.applicationSlug}. ` +
            'Run the "analyse" pipeline first before requesting coaching.',
        );
    }

    // Zod-validate the DynamoDB record (replaces 8× unsafe `as` casts)
    const record = AnalysisRecordSchema.parse(result.Items[0]);

    log('INFO', 'Analysis loaded', {
        handler: 'coach-loader', sk: record.sk,
        fitRating: record.metadata.overallFitRating,
    });

    // Reconstruct the AgentResult<StrategistAnalysisResult>
    // archetypeSelection and tailoredResumeData are not stored in the coaching
    // pipeline's DDB record — null is the correct value for loaded-from-DDB runs.
    const analysis: AgentResult<StrategistAnalysisResult> = {
        data: {
            analysisXml: record.analysisXml,
            metadata: record.metadata,
            coverLetter: record.coverLetter,
            archetypeSelection: null,
            tailoredResumeData: null,
            resumeSuggestions: record.resumeSuggestions,
            resumeAdditions: record.resumeAdditions,
            resumeReframes: record.resumeReframes,
            eslCorrections: record.eslCorrections,
        },
        tokenUsage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
        durationMs: 0,
        agentName: 'strategist-writer',
        modelId: 'loaded-from-ddb',
        costUsd: 0,
    };

    return {
        context,
        analysis,
    };
};
