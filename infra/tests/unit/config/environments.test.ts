/**
 * @format
 * Unit tests for environments.ts.
 *
 * Enforces the single-source-of-truth invariant: AWS account IDs must come
 * from process.env (set by GH Environment vars or local .env), never
 * hardcoded in source. See:
 *   docs/superpowers/specs/2026-05-05-eks-migration-design.md § 9.1
 *   docs/superpowers/plans/2026-05-05-eks-migration-01-account-id-consolidation.md
 */
import * as fs from 'fs';
import * as path from 'path';

const ENVIRONMENTS_FILE = path.resolve(
    __dirname,
    '../../../lib/config/environments.ts'
);

describe('environments.ts — single-source-of-truth invariant', () => {
    let source: string;

    beforeAll(() => {
        source = fs.readFileSync(ENVIRONMENTS_FILE, 'utf8');
    });

    it('does not contain any hardcoded 12-digit AWS account IDs', () => {
        // Strip line and block comments so documentation examples don't trip the regex.
        const stripped = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        const matches = stripped.match(/\b\d{12}\b/g) ?? [];
        expect(matches).toEqual([]);
    });
});

describe('environments.ts — runtime resolution', () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...ORIGINAL_ENV };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    it('reads DEVELOPMENT account from process.env.AWS_ACCOUNT_ID', () => {
        process.env.AWS_ACCOUNT_ID = '111111111111';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getEnvironmentConfig, Environment } = require('../../../lib/config/environments');
        expect(getEnvironmentConfig(Environment.DEVELOPMENT).account).toBe('111111111111');
    });

    it('reads MANAGEMENT account from process.env.ROOT_ACCOUNT', () => {
        process.env.ROOT_ACCOUNT = '222222222222';
        process.env.AWS_ACCOUNT_ID = '111111111111';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getEnvironmentConfig, Environment } = require('../../../lib/config/environments');
        expect(getEnvironmentConfig(Environment.MANAGEMENT).account).toBe('222222222222');
    });

    it('throws a clear error if AWS_ACCOUNT_ID is missing for non-management env', () => {
        delete process.env.AWS_ACCOUNT_ID;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getEnvironmentConfig, Environment } = require('../../../lib/config/environments');
        expect(() => getEnvironmentConfig(Environment.DEVELOPMENT).account).toThrow(
            /AWS_ACCOUNT_ID/
        );
    });
});
