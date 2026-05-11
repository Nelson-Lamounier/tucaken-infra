/**
 * @format
 * Bedrock usage repository — reads prompt_invocations and user_token_budgets
 * for the admin Cost tab (migration 013).
 *
 * prompt_invocations is written by:
 *   - agent-runner.ts onInvocationComplete (Converse API pipelines)
 *   - bedrock-cost.ts recordBedrockCost (direct InvokeModel pipelines)
 *
 * For direct InvokeModel rows: system_prompt_tokens=0, user_message_tokens=inputTokens.
 * Summary query sums both so the "tokens in" figure is consistent across both patterns.
 */
import type { Pool } from 'pg';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromptInvocationRow {
  id:             string;
  userId:         string | null;
  pipeline:       string;
  agent:          string;
  modelId:        string;
  inputTokens:    number;
  outputTokens:   number;
  totalCostCents: number;
  importId:       string | null;
  repoName:       string | null;
  invokedAt:      string;
}

export interface UsageSummary {
  rows:       PromptInvocationRow[];
  totalCents: number;
  byPipeline: Record<string, number>;
  byModel:    Record<string, number>;
}

export interface UserTokenBudget {
  userId:             string;
  monthlyLimitCents:  number;
  alertThresholdPct:  number;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getUsageSummary(
  pool:    Pool,
  userId?: string,
  month?:  string,
): Promise<UsageSummary> {
  const queryParams: string[] = [];
  const conditions: string[] = [];

  if (month) {
    queryParams.push(month);
    conditions.push(
      `invoked_at >= DATE_TRUNC('month', $${queryParams.length}::date)`,
      `invoked_at <  DATE_TRUNC('month', $${queryParams.length}::date) + INTERVAL '1 month'`,
    );
  } else {
    conditions.push(
      `invoked_at >= DATE_TRUNC('month', now())`,
      `invoked_at <  DATE_TRUNC('month', now()) + INTERVAL '1 month'`,
    );
  }

  if (userId) {
    queryParams.push(userId);
    conditions.push(`user_id = $${queryParams.length}`);
  }

  const { rows } = await pool.query<PromptInvocationRow>(
    `SELECT
       id,
       user_id                                          AS "userId",
       pipeline,
       agent,
       model_id                                         AS "modelId",
       (system_prompt_tokens + user_message_tokens)     AS "inputTokens",
       output_tokens                                    AS "outputTokens",
       total_cost_cents                                 AS "totalCostCents",
       import_id                                        AS "importId",
       repo_name                                        AS "repoName",
       invoked_at                                       AS "invokedAt"
     FROM prompt_invocations
     WHERE ${conditions.join(' AND ')}
     ORDER BY invoked_at DESC
     LIMIT 500`,
    queryParams,
  );

  // ── Aggregates ─────────────────────────────────────────────────────────────
  const totalCents = rows.reduce((sum, r) => sum + Number(r.totalCostCents), 0);

  const byPipeline: Record<string, number> = {};
  const byModel:    Record<string, number> = {};
  for (const row of rows) {
    byPipeline[row.pipeline] = (byPipeline[row.pipeline] ?? 0) + Number(row.totalCostCents);
    byModel[row.modelId]     = (byModel[row.modelId]     ?? 0) + Number(row.totalCostCents);
  }

  return { rows, totalCents, byPipeline, byModel };
}

export async function getUserBudget(
  pool:   Pool,
  userId: string,
): Promise<UserTokenBudget | null> {
  const { rows } = await pool.query<UserTokenBudget>(
    `SELECT
       user_id            AS "userId",
       monthly_limit_cents AS "monthlyLimitCents",
       alert_threshold_pct AS "alertThresholdPct"
     FROM user_token_budgets
     WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function setUserBudget(
  pool:               Pool,
  userId:             string,
  monthlyLimitCents:  number,
  alertThresholdPct:  number,
): Promise<void> {
  await pool.query(
    `INSERT INTO user_token_budgets (user_id, monthly_limit_cents, alert_threshold_pct)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET monthly_limit_cents = EXCLUDED.monthly_limit_cents,
           alert_threshold_pct = EXCLUDED.alert_threshold_pct,
           updated_at           = now()`,
    [userId, monthlyLimitCents, alertThresholdPct],
  );
}
