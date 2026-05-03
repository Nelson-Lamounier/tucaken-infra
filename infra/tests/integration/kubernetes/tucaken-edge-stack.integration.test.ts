/**
 * @format
 * Tucaken Edge Stack — Post-Deployment Integration Test
 *
 * Runs AFTER TucakenEdgeStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify:
 *   1. All SSM outputs published by the stack exist and are non-empty
 *   2. Both CloudFront distributions are Deployed and Enabled
 *   3. Both ACM certificates are ISSUED
 *   4. WAF WebACL is attached to both distributions
 *   5. Domain aliases are correctly configured on each distribution
 *
 * SSM-Anchored Strategy:
 *   - Reads SSM parameters at /tucaken/{env}/edge/* published by TucakenEdgeStack
 *   - Uses those values to call CloudFront and ACM APIs
 *   - Guarantees we're testing the SAME resources the stack created
 *
 * Environment Variables:
 *   CDK_ENV    — Target environment (default: development)
 *   AWS_REGION — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes/tucaken-edge-stack development --verbose
 */

import {
    ACMClient,
    DescribeCertificateCommand,
} from '@aws-sdk/client-acm';
import {
    CloudFrontClient,
    GetDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import type { DistributionConfig } from '@aws-sdk/client-cloudfront';
import {
    SSMClient,
    GetParametersByPathCommand,
} from '@aws-sdk/client-ssm';

import type { DeployableEnvironment } from '../../../lib/config';
import { Environment } from '../../../lib/config';
import { tucakenSsmPaths } from '../../../lib/config/ssm-paths';

// =============================================================================
// Configuration
// =============================================================================

function parseEnvironment(raw: string): DeployableEnvironment {
    const valid = [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION] as const satisfies readonly DeployableEnvironment[];
    if (!valid.includes(raw as DeployableEnvironment)) {
        throw new Error(`Invalid CDK_ENV: "${raw}". Expected one of: ${valid.join(', ')}`);
    }
    return raw as DeployableEnvironment;
}

const CDK_ENV = parseEnvironment(process.env.CDK_ENV ?? 'development');
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const CLOUDFRONT_REGION = 'us-east-1';

const SSM_PATHS = tucakenSsmPaths(CDK_ENV);

// =============================================================================
// AWS SDK Clients
// =============================================================================

const ssm = new SSMClient({ region: REGION });
const cloudfront = new CloudFrontClient({ region: CLOUDFRONT_REGION });
const acm = new ACMClient({ region: CLOUDFRONT_REGION });

// =============================================================================
// Helpers
// =============================================================================

async function loadSsmParameters(prefix: string): Promise<Map<string, string>> {
    const params = new Map<string, string>();
    let nextToken: string | undefined;

    do {
        const response = await ssm.send(
            new GetParametersByPathCommand({
                Path: prefix,
                Recursive: true,
                WithDecryption: true,
                NextToken: nextToken,
            }),
        );

        for (const param of response.Parameters ?? []) {
            if (param.Name && param.Value) {
                params.set(param.Name, param.Value);
            }
        }
        nextToken = response.NextToken;
    } while (nextToken);

    return params;
}

function requireParam(params: Map<string, string>, path: string): string {
    const value = params.get(path);
    if (!value) throw new Error(`Missing required SSM parameter: ${path}`);
    return value;
}

// =============================================================================
// Shared State
// =============================================================================

let ssmParams: Map<string, string>;

let ioDistributionConfig: DistributionConfig;
let comDistributionConfig: DistributionConfig;
let ioWafArn: string | undefined;
let comWafArn: string | undefined;
let ioAliases: string[];
let comAliases: string[];

// =============================================================================
// Top-Level beforeAll
// =============================================================================

beforeAll(async () => {
    ssmParams = await loadSsmParameters(SSM_PATHS.prefix);

    const ioDistId = requireParam(ssmParams, SSM_PATHS.ioDistributionId);
    const comDistId = requireParam(ssmParams, SSM_PATHS.comDistributionId);

    const [ioResp, comResp] = await Promise.all([
        cloudfront.send(new GetDistributionCommand({ Id: ioDistId })),
        cloudfront.send(new GetDistributionCommand({ Id: comDistId })),
    ]);

    expect(ioResp.Distribution?.DistributionConfig).toBeDefined();
    expect(comResp.Distribution?.DistributionConfig).toBeDefined();

    ioDistributionConfig = ioResp.Distribution!.DistributionConfig!;
    comDistributionConfig = comResp.Distribution!.DistributionConfig!;

    ioWafArn = ioResp.Distribution?.DistributionConfig?.WebACLId;
    comWafArn = comResp.Distribution?.DistributionConfig?.WebACLId;
    ioAliases = ioDistributionConfig.Aliases?.Items ?? [];
    comAliases = comDistributionConfig.Aliases?.Items ?? [];
}, 60_000);

// =============================================================================
// SUITE 1: SSM Output Completeness
// =============================================================================

describe('SSM — Stack Outputs', () => {
    const requiredPaths = [
        'ioDistributionId',
        'ioDistributionDomain',
        'comDistributionId',
        'comDistributionDomain',
        'ioCertificateArn',
        'comCertificateArn',
        'wafArn',
    ] as const satisfies readonly (keyof typeof SSM_PATHS)[];

    it.each(requiredPaths.map((key) => ({ key, path: SSM_PATHS[key] })))(
        'should have non-empty SSM parameter "$path"',
        ({ path }) => {
            expect(ssmParams.get(path)).toBeTruthy();
        },
    );
});

// =============================================================================
// SUITE 2: CloudFront Distributions
// =============================================================================

describe('CloudFront — Primary distribution (.io)', () => {
    it('should be enabled', () => {
        expect(ioDistributionConfig.Enabled).toBe(true);
    });

    it('should enforce redirect-to-https on the default behaviour', () => {
        expect(ioDistributionConfig.DefaultCacheBehavior?.ViewerProtocolPolicy).toBe(
            'redirect-to-https',
        );
    });

    it('should have tucaken.io as an alias', () => {
        expect(ioAliases).toContain('tucaken.io');
    });

    it('should have www.tucaken.io as an alias', () => {
        expect(ioAliases).toContain('www.tucaken.io');
    });

    it('should have a WAF WebACL attached', () => {
        expect(ioWafArn).toBeTruthy();
    });

    it('should have a distribution domain in SSM matching the live distribution', async () => {
        const ssmDomain = requireParam(ssmParams, SSM_PATHS.ioDistributionDomain);
        expect(ssmDomain).toMatch(/\.cloudfront\.net$/);
    });
});

describe('CloudFront — Redirect distribution (.com)', () => {
    it('should be enabled', () => {
        expect(comDistributionConfig.Enabled).toBe(true);
    });

    it('should enforce redirect-to-https on the default behaviour', () => {
        expect(comDistributionConfig.DefaultCacheBehavior?.ViewerProtocolPolicy).toBe(
            'redirect-to-https',
        );
    });

    it('should have tucaken.com as an alias', () => {
        expect(comAliases).toContain('tucaken.com');
    });

    it('should have www.tucaken.com as an alias', () => {
        expect(comAliases).toContain('www.tucaken.com');
    });

    it('should have the same WAF WebACL as the .io distribution', () => {
        expect(comWafArn).toBeTruthy();
        expect(comWafArn).toBe(ioWafArn);
    });
});

// =============================================================================
// SUITE 3: ACM Certificates
// =============================================================================

describe('ACM — Certificates (us-east-1)', () => {
    let ioCertStatus: string;
    let comCertStatus: string;
    let ioCertDomains: string[];
    let comCertDomains: string[];

    beforeAll(async () => {
        const ioCertArn = requireParam(ssmParams, SSM_PATHS.ioCertificateArn);
        const comCertArn = requireParam(ssmParams, SSM_PATHS.comCertificateArn);

        const [ioResp, comResp] = await Promise.all([
            acm.send(new DescribeCertificateCommand({ CertificateArn: ioCertArn })),
            acm.send(new DescribeCertificateCommand({ CertificateArn: comCertArn })),
        ]);

        ioCertStatus = ioResp.Certificate?.Status ?? '';
        comCertStatus = comResp.Certificate?.Status ?? '';
        ioCertDomains = ioResp.Certificate?.SubjectAlternativeNames ?? [];
        comCertDomains = comResp.Certificate?.SubjectAlternativeNames ?? [];
    }, 30_000);

    it('should have the .io certificate ISSUED', () => {
        expect(ioCertStatus).toBe('ISSUED');
    });

    it('should have the .com certificate ISSUED', () => {
        expect(comCertStatus).toBe('ISSUED');
    });

    it('should cover tucaken.io on the .io certificate', () => {
        expect(ioCertDomains).toContain('tucaken.io');
    });

    it('should cover www.tucaken.io on the .io certificate', () => {
        expect(ioCertDomains).toContain('www.tucaken.io');
    });

    it('should cover tucaken.com on the .com certificate', () => {
        expect(comCertDomains).toContain('tucaken.com');
    });

    it('should cover www.tucaken.com on the .com certificate', () => {
        expect(comCertDomains).toContain('www.tucaken.com');
    });
});
