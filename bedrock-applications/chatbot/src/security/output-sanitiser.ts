/**
 * @format
 * Output Sanitiser — Security Layer 5
 *
 * Post-model output filter that redacts sensitive patterns from
 * agent responses. Prevents accidental leakage of infrastructure
 * identifiers, AWS resource ARNs, IP addresses, and credentials.
 *
 * Separated from the handler following the gold-standard article pipeline
 * pattern where security concerns live in dedicated modules.
 *
 * @example
 * ```typescript
 * import { sanitiseOutput } from '../security/output-sanitiser.js';
 *
 * const sanitised = sanitiseOutput(rawResponse);
 * const wasRedacted = sanitised !== rawResponse;
 * ```
 */

// =============================================================================
// REDACTION PATTERNS
// =============================================================================

/**
 * Patterns to redact from agent responses.
 *
 * Each entry maps a regex to a descriptive placeholder. The user
 * receives a useful, contextual answer without raw technical identifiers.
 *
 * Patterns are applied in order — more specific patterns (e.g. ARNs)
 * should precede less specific ones (e.g. 12-digit numbers) to avoid
 * partial redaction artefacts.
 */
const SENSITIVE_OUTPUT_PATTERNS: ReadonlyArray<{ readonly regex: RegExp; readonly replacement: string }> = [
    // AWS resource identifiers — most specific first to avoid partial redaction artefacts
    { regex: /arn:aws:[a-zA-Z0-9-]+:[a-z0-9-]*:\d{12}:[^\s,)}\]]+/g, replacement: '[AWS Resource]' },
    { regex: /\b\d{12}\b/g, replacement: '[Account ID]' },
    { regex: /\b[A-Z0-9]{20}\b/g, replacement: '[Access Key]' },
    // Network identifiers
    { regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP Address]' },
    { regex: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}[^\s]*/g, replacement: '[Internal URL]' },
    // Gap S3: Internal hostname redaction — catches Kubernetes cluster-internal
    // service endpoints (*.cluster.local), VPC-internal DNS (*.internal), and
    // mDNS / link-local hostnames (*.local) that could expose infrastructure topology.
    { regex: /\b[a-z][a-z0-9-]{2,62}\.(internal|local|cluster\.local)\b/gi, replacement: '[Internal Host]' },
    // Credentials in key=value / key: value form
    { regex: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi, replacement: '[REDACTED]' },
];

// =============================================================================
// SANITISATION FUNCTION
// =============================================================================

/**
 * Redact sensitive patterns from agent response text.
 *
 * Silently replaces infrastructure identifiers with descriptive
 * placeholders. The user receives a useful, contextual answer
 * without raw technical identifiers.
 *
 * @param raw - Raw agent response text
 * @returns Sanitised response with sensitive patterns redacted
 */
export function sanitiseOutput(raw: string): string {
    let sanitised = raw;
    for (const { regex, replacement } of SENSITIVE_OUTPUT_PATTERNS) {
        sanitised = sanitised.replace(regex, replacement);
    }
    return sanitised;
}
