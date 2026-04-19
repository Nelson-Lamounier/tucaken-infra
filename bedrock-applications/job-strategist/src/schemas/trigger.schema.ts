/**
 * @format
 * Trigger Request Schemas — Zod Runtime Validation
 *
 * Validates API Gateway request bodies for the Strategist Trigger Handler.
 * Replaces unsafe `JSON.parse() as TriggerRequestBody` with strict
 * schema-based parsing at the external boundary.
 *
 * @see trigger-handler.ts
 */

import { z } from 'zod';

// =============================================================================
// INTERVIEW STAGE ENUM
// =============================================================================

/**
 * Valid interview stage values.
 *
 * Mirrors the `InterviewStage` union type from shared types but enforced
 * at runtime via Zod enum validation.
 */
const INTERVIEW_STAGES = [
    'applied',
    'phone-screen',
    'technical-1',
    'technical-2',
    'behavioural',
    'system-design',
    'take-home',
    'final-round',
    'offer',
    'rejected',
    'withdrawn',
] as const;

// =============================================================================
// ANALYSE REQUEST
// =============================================================================

/**
 * Schema for the 'analyse' operation request body.
 *
 * Validates all required fields for triggering the full analysis
 * pipeline: Research → Strategist → Persist.
 *
 * `.strict()` rejects unrecognised fields to prevent object injection.
 */
export const AnalyseRequestSchema = z
    .object({
        operation: z.literal('analyse'),
        jobDescription: z
            .string()
            .min(50, 'Job description must be at least 50 characters')
            .max(50_000, 'Job description must be at most 50,000 characters'),
        targetCompany: z
            .string()
            .min(1, 'Target company is required')
            .max(200, 'Target company must be at most 200 characters'),
        targetRole: z
            .string()
            .min(1, 'Target role is required')
            .max(200, 'Target role must be at most 200 characters'),
        resumeId: z
            .string()
            .max(100, 'Resume ID must be at most 100 characters')
            .optional()
            .default(''),
        includeCoverLetter: z
            .boolean()
            .optional()
            .default(true)
            .describe('Whether to generate a cover letter (defaults to true)'),
    })
    .strict();

// =============================================================================
// COACH REQUEST
// =============================================================================

/**
 * Schema for the 'coach' operation request body.
 *
 * Validates all required fields for triggering the coaching
 * pipeline: Load Analysis → Coach → Persist.
 *
 * `.strict()` rejects unrecognised fields to prevent object injection.
 */
export const CoachRequestSchema = z
    .object({
        operation: z.literal('coach'),
        applicationSlug: z
            .string()
            .min(1, 'Application slug is required')
            .max(200, 'Application slug must be at most 200 characters')
            .regex(/^[a-z0-9-]+$/, 'Application slug must be kebab-case'),
        interviewStage: z.enum(INTERVIEW_STAGES, {
            errorMap: () => ({
                message: `Interview stage must be one of: ${INTERVIEW_STAGES.join(', ')}`,
            }),
        }),
    })
    .strict();

// =============================================================================
// DISCRIMINATED UNION
// =============================================================================

/**
 * Discriminated union of all valid trigger request bodies.
 *
 * Uses `z.discriminatedUnion` on the `operation` field for
 * efficient dispatch — Zod checks `operation` first, then
 * validates the matching schema.
 */
export const TriggerRequestSchema = z.discriminatedUnion('operation', [
    AnalyseRequestSchema,
    CoachRequestSchema,
]);

// =============================================================================
// INFERRED TYPES
// =============================================================================

/** Validated analyse request — inferred from schema */
export type AnalyseRequest = z.infer<typeof AnalyseRequestSchema>;

/** Validated coach request — inferred from schema */
export type CoachRequest = z.infer<typeof CoachRequestSchema>;

/** Validated trigger request — discriminated union */
export type TriggerRequest = z.infer<typeof TriggerRequestSchema>;
