/**
 * @format
 * Tagging Guard — Architectural Constraint Test
 *
 * Ensures the TaggingAspect (applied in app.ts) is the SOLE source of truth
 * for resource tags. Manual `cdk.Tags.of(...).add(...)` calls in stack or
 * construct files would conflict with the aspect — particularly on IAM
 * resources where tag keys are case-insensitive.
 *
 * This test scans TypeScript source files and fails CI if any manual
 * tag application is found, preventing the "Duplicate tag keys" IAM
 * error we hit in production (March 2026).
 */

import { readFileSync } from 'fs';
import { resolve, relative } from 'path';

import glob from 'glob';

const LIB_DIR = resolve(__dirname, '../../../lib');

/** Pattern that matches `Tags.of(...)` or `cdk.Tags.of(...)`. */
const TAG_PATTERN = /(?:cdk\.)?Tags\.of\s*\(/;

/** Files that are allowed to use Tags (the aspect itself). */
const ALLOWED_FILES = [
    'aspects/tagging-aspect.ts',
    'constructs/compute/constructs/auto-scaling-group.ts',
    'stacks/kubernetes/worker-asg-stack.ts',
    // EKS subnet discovery tags — exact key/value semantics required by
    // EKS + AWS LB Controller; can't be expressed via TaggingAspect.
    'shared/vpc-stack.ts',
    // EKS cluster identification tag — propagates to dependent resources.
    'stacks/kubernetes/eks-cluster-stack.ts',
];

function isAllowed(filePath: string): boolean {
    const rel = relative(LIB_DIR, filePath);
    return ALLOWED_FILES.some((allowed) => rel === allowed || rel.endsWith(allowed));
}

/**
 * Scan TypeScript source files for manual tag applications.
 * Returns an array of violation records for any file that uses Tags.of()
 * outside the allowed tagging-aspect module.
 */
function findTagViolations(
    tsFiles: string[],
): { file: string; line: number; content: string }[] {
    const violations: { file: string; line: number; content: string }[] = [];

    for (const filePath of tsFiles) {
        if (isAllowed(filePath)) continue;

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Skip comments
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;

            if (TAG_PATTERN.test(line)) {
                violations.push({
                    file: relative(LIB_DIR, filePath),
                    line: i + 1,
                    content: line.trim(),
                });
            }
        }
    }

    return violations;
}

describe('Tagging Guard', () => {
    const tsFiles = glob.sync('**/*.ts', {
        cwd: LIB_DIR,
        absolute: true,
        ignore: ['**/node_modules/**', '**/*.d.ts', '**/*.test.ts'],
    });

    it('should find TypeScript source files to scan', () => {
        expect(tsFiles.length).toBeGreaterThan(0);
    });

    it('should not have manual cdk.Tags.of() calls outside tagging-aspect.ts', () => {
        const violations = findTagViolations(tsFiles);

        expect(violations).toHaveLength(0);
    });
});
