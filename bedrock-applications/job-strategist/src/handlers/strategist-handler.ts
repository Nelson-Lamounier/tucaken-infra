/**
 * @format
 * Strategist Handler — Analysis Pipeline Stage 2
 *
 * Lambda handler invoked by Step Functions as the second stage
 * of the analysis pipeline. Receives research results, executes
 * the Strategist Agent for the 5-phase analysis, and returns
 * results for the Resume Builder / Analysis Persist handlers.
 *
 * **Payload offloading:** The full `analysisXml` is written to S3
 * and replaced with a reference key in the Step Functions payload.
 * This keeps the inter-state payload safely under the 256KB limit.
 * The Analysis Persist Handler reads the XML back from S3.
 *
 * Input: { context, research }
 * Output: { context (trimmed), research (trimmed), analysis (xml offloaded to S3) }
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

import { executeStrategistAgent } from '../agents/strategist-agent.js';
import { PersistHandlerEnvSchema } from '../schemas/environment.schema.js';
import type {
    StrategistWriterHandlerInput,
    StrategistAnalysisPersistInput,
} from '../../../shared/src/index.js';

import { log } from '../../../shared/src/index.js';

// =============================================================================
// ENVIRONMENT VALIDATION (fail-fast at cold start)
// =============================================================================

const env = PersistHandlerEnvSchema.parse(process.env);

// =============================================================================
// CLIENTS
// =============================================================================

const s3 = new S3Client({});

/** S3 bucket for pipeline artefacts (shared assets bucket) */
const ASSETS_BUCKET = env.ASSETS_BUCKET;

/**
 * Lambda handler for the Strategist Agent.
 *
 * @param event - Step Functions input with research results
 * @returns Trimmed payload with analysisXml offloaded to S3
 */
export const handler = async (
    event: StrategistWriterHandlerInput,
): Promise<StrategistAnalysisPersistInput> => {
    if (!event?.context?.pipelineId) {
        throw new Error(
            '[strategist-writer-handler] Invalid Step Functions event: "context.pipelineId" is missing. ' +
            'This handler must be invoked by the Analysis State Machine, not directly.',
        );
    }

    log('INFO', 'Generating analysis', {
        handler: 'strategist-writer-handler', pipelineId: event.context.pipelineId,
        targetRole: event.context.targetRole,
    });

    const analysis = await executeStrategistAgent(event.context, event.research.data);

    // ─── S3 offload: analysisXml ──────────────────────────────────
    // The full XML analysis is typically 80–150 KB. Combined with
    // context (resumeData ~30KB) and research data, the total payload
    // easily exceeds the Step Functions 256KB limit.
    //
    // We write the XML to S3 and replace it with a reference key.
    // The Analysis Persist Handler reads it back from S3.
    // ──────────────────────────────────────────────────────────────

    const xmlS3Key = `strategist/analysis-xml/${event.context.pipelineId}.xml`;
    const xmlBytes = Buffer.byteLength(analysis.data.analysisXml, 'utf-8');

    if (ASSETS_BUCKET) {
        await s3.send(new PutObjectCommand({
            Bucket: ASSETS_BUCKET,
            Key: xmlS3Key,
            Body: analysis.data.analysisXml,
            ContentType: 'application/xml',
        }));
        log('INFO', 'Offloaded analysisXml to S3', {
            handler: 'strategist-writer-handler', sizeKb: (xmlBytes / 1024).toFixed(1),
            bucket: ASSETS_BUCKET, key: xmlS3Key,
        });
    }

    // ─── Payload trimming ─────────────────────────────────────────
    // Strip fields no longer needed downstream:
    //   Context:
    //     • jobDescription — only used by Research + Strategist
    //   Research:
    //     • kbContext       — huge concatenated KB text; only used by Strategist
    //     • verifiedMatches, partialMatches, gaps — persisted in final stage
    //     • resumeData     — duplicate of context.resumeData
    //   Analysis:
    //     • analysisXml    — offloaded to S3 (replaced with S3 key)
    //
    // NOTE: context.resumeData is KEPT — Resume Builder needs it.
    // ──────────────────────────────────────────────────────────────

    const trimmedContext = {
        ...event.context,
        jobDescription: '[trimmed]',
    };

    const trimmedResearch = {
        ...event.research,
        data: {
            ...event.research.data,
            kbContext: '[trimmed]',
            resumeConstraints: '[trimmed]',
            verifiedMatches: [],
            partialMatches: [],
            gaps: [],
            resumeData: null,
        },
    };

    const trimmedAnalysis = {
        ...analysis,
        data: {
            ...analysis.data,
            analysisXml: `s3://${ASSETS_BUCKET}/${xmlS3Key}`,
        },
    };

    const payload = { context: trimmedContext, research: trimmedResearch, analysis: trimmedAnalysis };
    const payloadSize = JSON.stringify(payload).length;
    log('INFO', 'Output payload trimmed', {
        handler: 'strategist-writer-handler',
        payloadSizeKb: (payloadSize / 1024).toFixed(1),
        xmlOffloadedKb: (xmlBytes / 1024).toFixed(1),
    });

    if (payloadSize > 250 * 1024) {
        log('WARN', 'Payload still near 256KB limit', {
            handler: 'strategist-writer-handler', payloadSizeKb: (payloadSize / 1024).toFixed(1),
        });
    }

    return payload;
};
