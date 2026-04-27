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

export const MAX_NAME_LEN = 63;

export function sanitizeLabel(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_NAME_LEN);
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

export function buildPipelineJob(input: BuildJobInput): V1Job {
    const suffix  = createHash('sha1').update(input.suffixInput).digest('hex').slice(0, 8);
    const stem    = sanitizeLabel(input.nameStem).slice(0, 50);
    const jobName = `${stem}-${suffix}`.slice(0, MAX_NAME_LEN);
    const sanitisedLabels = Object.fromEntries(
        Object.entries(input.labels).map(([k, v]) => [k, sanitizeLabel(v).slice(0, 63) || 'unknown']),
    );
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
                        env:     input.env,
                        envFrom: input.envFromSecretRefs.map(name => ({ secretRef: { name } })),
                        resources: input.resources ?? DEFAULT_RESOURCES,
                    }],
                },
            },
        },
    };
}
