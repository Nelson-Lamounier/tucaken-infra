/**
 * @format
 * Prompt Observability repository — typed pg queries for
 * prompt_invocations and prompt_feedback tables (migration 011).
 *
 * Writes:
 *   prompt_invocations — written directly by pipeline K8s Jobs via
 *                        onInvocationComplete callback in agent-runner.
 *                        admin-api provides the feedback endpoints only.
 *
 * Reads:
 *   prompt_feedback stats — aggregated quality metrics for the dashboard.
 */
import type { Pool } from 'pg';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromptFeedbackInput {
  invocationId:       string | null;
  userId:             string;
  rating:             1 | -1;
  feedbackText:       string | null;
  feedbackCategories: string[];
}

export interface PromptFeedback {
  id:                 string;
  invocationId:       string | null;
  userId:             string;
  rating:             number;
  feedbackText:       string | null;
  feedbackCategories: string[];
  adminReviewed:      boolean;
  adminNotes:         string | null;
  adminSeverity:      string | null;
  createdAt:          string;
}

export interface PromptQualityStats {
  pipeline:        string;
  agent:           string;
  totalInvocations: number;
  thumbsUp:        number;
  thumbsDown:      number;
  badRate:         number;    // thumbsDown / (thumbsUp + thumbsDown), 0 if no feedback
  avgLatencyMs:    number;
  avgTotalCostCents: number;
  cacheHitRate:    number;    // cache_hit invocations / total
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export async function createPromptFeedback(
  pool: Pool,
  input: PromptFeedbackInput,
): Promise<PromptFeedback> {
  const { rows } = await pool.query<PromptFeedback>(
    `INSERT INTO prompt_feedback
       (invocation_id, user_id, rating, feedback_text, feedback_categories)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING
       id,
       invocation_id   AS "invocationId",
       user_id         AS "userId",
       rating,
       feedback_text   AS "feedbackText",
       feedback_categories AS "feedbackCategories",
       admin_reviewed  AS "adminReviewed",
       admin_notes     AS "adminNotes",
       admin_severity  AS "adminSeverity",
       created_at      AS "createdAt"`,
    [
      input.invocationId ?? null,
      input.userId,
      input.rating,
      input.feedbackText ?? null,
      input.feedbackCategories ?? [],
    ],
  );
  if (!rows[0]) throw new Error('createPromptFeedback: INSERT returned no row');
  return rows[0];
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Aggregate quality stats grouped by (pipeline, agent).
 * Joins prompt_invocations with prompt_feedback to compute bad rates.
 *
 * @param days Number of days to look back (7 / 30 / 365)
 */
export async function getPromptQualityStats(
  pool: Pool,
  days: number,
): Promise<PromptQualityStats[]> {
  const { rows } = await pool.query<PromptQualityStats>(
    `SELECT
       pi.pipeline,
       pi.agent,
       COUNT(*)::int                                                         AS "totalInvocations",
       COALESCE(SUM(CASE WHEN pf.rating =  1 THEN 1 ELSE 0 END)::int, 0)  AS "thumbsUp",
       COALESCE(SUM(CASE WHEN pf.rating = -1 THEN 1 ELSE 0 END)::int, 0)  AS "thumbsDown",
       CASE
         WHEN COUNT(pf.id) = 0 THEN 0
         ELSE ROUND(
           SUM(CASE WHEN pf.rating = -1 THEN 1 ELSE 0 END)::numeric
           / COUNT(pf.id) * 100, 1
         )
       END                                                                   AS "badRate",
       ROUND(AVG(pi.latency_ms))::int                                       AS "avgLatencyMs",
       ROUND(AVG(pi.total_cost_cents))::int                                 AS "avgTotalCostCents",
       ROUND(
         SUM(CASE WHEN pi.cache_hit THEN 1 ELSE 0 END)::numeric
         / COUNT(*) * 100, 1
       )                                                                     AS "cacheHitRate"
     FROM prompt_invocations pi
     LEFT JOIN prompt_feedback pf ON pf.invocation_id = pi.id
     WHERE pi.invoked_at >= NOW() - ($1 || ' days')::INTERVAL
     GROUP BY pi.pipeline, pi.agent
     ORDER BY pi.pipeline, pi.agent`,
    [days],
  );
  return rows;
}
