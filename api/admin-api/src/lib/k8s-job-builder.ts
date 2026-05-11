/**
 * @format
 * Shared K8s Job builder used by routes that dispatch background work
 * (article-pipeline, strategist-pipeline, coach-pipeline).
 *
 * Centralises the conventions:
 *   - 63-char DNS-label limit, sha1-derived deterministic suffix
 *   - sanitised label values (downcased + non-alnum stripped)
 *   - sensible default resource requests/limits, ttl, backoff,
 *     activeDeadlineSeconds, restartPolicy=Never
 */
import { createHash } from 'node:crypto';

import type { V1Job } from '@kubernetes/client-node';
import { context as otelContext, propagation } from '@opentelemetry/api';

export const MAX_NAME_LEN = 63;

export function sanitizeLabel(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_NAME_LEN);
}

/**
 * Serialise the current OTel active span into a W3C TRACEPARENT env var
 * for injection into K8s Job specs. Workers read this to continue the trace.
 * Returns null when no active span exists (e.g. local dev, tests).
 */
export function traceParentEnv(): { name: string; value: string } | null {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    const traceparent = carrier['traceparent'];
    return traceparent ? { name: 'TRACEPARENT', value: traceparent } : null;
}

export interface BuildJobInput {
    namespace:           string;
    image:               string;
    serviceAccountName:  string;
    nameStem:            string;
    suffixInput:         string;
    labels:              Record<string, string>;
    command:             string[];
    env:                 { name: string; value: string }[];
    envFromSecretRefs:   string[];
    activeDeadlineSeconds?: number;   // default 1800
    resources?: {
        requests: { memory: string; cpu: string };
        limits:   { memory: string; cpu: string };
    };
}

const DEFAULT_RESOURCES = {
    requests: { memory: '768Mi', cpu: '300m' },
    limits:   { memory: '2Gi',   cpu: '1000m' },
};

/**
 * Returns the standard observability env vars every K8s Job pod inherits.
 * Centralised here so all dispatch routes (ingestion, article-pipeline,
 * job-strategist, resume-import) carry identical OTel + Pyroscope +
 * Pushgateway wiring without per-route copy-paste drift.
 *
 * @param serviceName  service.name on every span and Pushgateway group key.
 * @param suffixInput  unique-per-run identifier (e.g. importId, pipelineRunId)
 *                     — flows into trace resource attributes for searchability.
 */
export function observabilityEnv(serviceName: string, suffixInput: string): { name: string; value: string }[] {
    const env = process.env['DEPLOY_ENV'] ?? 'dev';
    return [
        { name: 'OTEL_SERVICE_NAME',           value: serviceName },
        { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://alloy.monitoring.svc.cluster.local:4318' },
        { name: 'OTEL_RESOURCE_ATTRIBUTES',    value: `deployment.environment=${env},k8s.cluster=portfolio,run.id=${suffixInput}` },
        { name: 'PYROSCOPE_SERVER_ADDRESS',    value: 'http://pyroscope.monitoring.svc.cluster.local:4040' },
        { name: 'PUSHGATEWAY_URL',             value: 'http://pushgateway.monitoring.svc.cluster.local:9091' },
        { name: 'DEPLOY_ENV',                  value: env },
        { name: 'LOG_LEVEL',                   value: 'info' },
    ];
}

export function buildPipelineJob(input: BuildJobInput): V1Job {
    const suffix  = createHash('sha1').update(input.suffixInput).digest('hex').slice(0, 8);
    const stem    = sanitizeLabel(input.nameStem).slice(0, 50);
    const jobName = `${stem}-${suffix}`.slice(0, MAX_NAME_LEN);
    const sanitisedLabels = Object.fromEntries(
        Object.entries(input.labels).map(([k, v]) => [k, sanitizeLabel(v).slice(0, 63) || 'unknown']),
    );

    // Auto-merge observability env. Caller's env wins on conflict — the
    // default merge order (spread caller last) is intentional so a route
    // can override OTEL_SERVICE_NAME for nested operations (e.g. coach
    // sub-pipeline) without losing the rest.
    const obsName = sanitizeLabel(input.nameStem.split('-').slice(0, -1).join('-')) || input.nameStem;
    const env = [
        ...observabilityEnv(obsName, input.suffixInput),
        ...input.env,
    ];

    return {
        apiVersion: 'batch/v1',
        kind:       'Job',
        metadata: { name: jobName, namespace: input.namespace, labels: sanitisedLabels },
        spec: {
            ttlSecondsAfterFinished: 3600,
            backoffLimit:            2,
            activeDeadlineSeconds:   input.activeDeadlineSeconds ?? 1800,
            template: {
                metadata: { labels: sanitisedLabels },
                spec: {
                    restartPolicy:      'Never',
                    serviceAccountName: input.serviceAccountName,
                    containers: [{
                        name:    'pipeline',
                        image:   input.image,
                        command: input.command,
                        env,
                        envFrom: input.envFromSecretRefs.map(name => ({ secretRef: { name } })),
                        resources: input.resources ?? DEFAULT_RESOURCES,
                    }],
                },
            },
        },
    };
}
