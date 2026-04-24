/**
 * @format
 * Launch Template — Golden AMI Consistency Integration Test
 *
 * Validates that every compute Launch Template (control-plane, general-pool,
 * monitoring-pool) uses the AMI ID currently published to SSM by the Golden
 * AMI pipeline in the kubernetes-bootstrap repository.
 *
 * What this gates:
 *   When a new Golden AMI is baked in kubernetes-bootstrap, the SSM parameter
 *   /k8s/{env}/golden-ami/latest is updated. However, the Launch Templates in
 *   this repository only pick up the new AMI ID when cdk-monitoring redeploys
 *   the compute stacks — CloudFormation resolves the SSM dynamic reference at
 *   deploy time and stores the concrete AMI ID in the Launch Template version.
 *   This test catches the drift: SSM has a newer AMI but the Launch Template
 *   still references the old one. New ASG instances would boot the stale image.
 *
 * IMPORTANT — which LT version is checked:
 *   CloudFormation never moves the $Default pointer on a Launch Template. It
 *   writes the specific version number into the ASG resource (e.g. "Version: 56")
 *   and leaves $Default at v1 forever. Checking $Default always returns the
 *   original AMI and produces false positives. This test resolves the version
 *   actually referenced by each ASG via DescribeAutoScalingGroups and then
 *   describes that exact Launch Template version.
 *
 * Vacuous-pass rule:
 *   If the Golden AMI SSM parameter does not exist (Day-0 before the first AMI
 *   bake), all assertions pass with a console warning. Enforcement only kicks in
 *   once at least one Golden AMI has been built.
 *
 * Three Launch Templates verified (derived from NAME_PREFIX = flatName('k8s', '', CDK_ENV)):
 *   - {NAME_PREFIX}-lt                  (control plane)
 *   - {NAME_PREFIX}-general-pool-lt     (general worker pool)
 *   - {NAME_PREFIX}-monitoring-pool-lt  (monitoring worker pool)
 *
 * Environment Variables:
 *   CDK_ENV    — Target environment (default: development)
 *   AWS_REGION — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes/launch-template-ami $CDK_ENV --verbose
 *
 * @example Local invocation:
 *   just test-integration kubernetes/launch-template-ami development
 */

import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
    EC2Client,
    DescribeLaunchTemplateVersionsCommand,
    DescribeImagesCommand,
    type Image,
} from '@aws-sdk/client-ec2';
import {
    SSMClient,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';

import type { Environment } from '../../../lib/config';
import { flatName } from '../../../lib/utilities/naming';

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';

/** Resource name prefix — e.g. 'k8s-dev' for development */
const NAME_PREFIX = flatName('k8s', '', CDK_ENV);

/** SSM parameter written by kubernetes-bootstrap GoldenAmiStack */
const GOLDEN_AMI_SSM_PATH = `/k8s/${CDK_ENV}/golden-ami/latest`;

/**
 * Every compute Launch Template + its associated ASG.
 * ASG names follow the same prefix convention as the CDK stacks.
 * The test resolves the LT version from the ASG config, not $Default.
 */
const LAUNCH_TEMPLATES = [
    { name: `${NAME_PREFIX}-lt`,                  asgName: `${NAME_PREFIX}-asg`,                  label: 'Control Plane' },
    { name: `${NAME_PREFIX}-general-pool-lt`,     asgName: `${NAME_PREFIX}-general-pool-asg`,     label: 'General Pool' },
    { name: `${NAME_PREFIX}-monitoring-pool-lt`,  asgName: `${NAME_PREFIX}-monitoring-pool-asg`,  label: 'Monitoring Pool' },
] as const;

/**
 * Tags that must have exact values on every Golden AMI, both the current SSM
 * AMI and any AMI still referenced by a Launch Template default version.
 * A mismatch indicates the new AMI was built with a different tagging schema
 * or the old AMI was incorrectly tagged — both are actionable.
 */
const GOLDEN_AMI_FIXED_TAGS: Readonly<Record<string, string>> = {
    Purpose:        'GoldenAMI',
    Component:      'ImageBuilder',
    ManagedBy:      'kubernetes-bootstrap',
    BootstrapBaked: 'true',
};

/**
 * Tag keys that must exist on every Golden AMI but whose values are expected
 * to differ between AMI generations (e.g. KubernetesVersion changes on upgrade).
 * Detecting missing keys flags a broken tagging pipeline early.
 */
const GOLDEN_AMI_REQUIRED_TAG_KEYS = [
    'KubernetesVersion',
    'ContainerdVersion',
    'CalicoVersion',
    'K8sGPTVersion',
] as const;

/**
 * Vacuous-pass sentinel — same pattern used across all integration tests.
 * Tests emit a warning and pass when the prerequisite resource is absent
 * (Day-0 or Golden AMI not yet baked).
 */
const VACUOUS = 'VACUOUS_PASS' as const;

// AWS SDK clients
const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const asg = new AutoScalingClient({ region: REGION });

// =============================================================================
// Helpers
// =============================================================================

/**
 * Resolve the LT version that the ASG is actively configured to use.
 * CloudFormation writes an explicit version number into the ASG resource
 * (e.g. "56") — never "$Default". Checking "$Default" would always return
 * the original v1 AMI and produce false positives.
 *
 * Falls back to "$Latest" if the ASG does not exist yet (Day-0).
 */
async function getAsgLtVersion(asgName: string, _ltName: string): Promise<string> {
    try {
        const { AutoScalingGroups } = await asg.send(
            new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName] }),
        );
        const group = AutoScalingGroups?.[0];
        const version = group?.LaunchTemplate?.Version ?? group?.MixedInstancesPolicy?.LaunchTemplate?.LaunchTemplateSpecification?.Version;
        return version ?? '$Latest';
    } catch {
        return '$Latest';
    }
}

/**
 * Fetch the AMI ID from a specific Launch Template version.
 * Returns undefined if the Launch Template does not exist yet.
 */
async function getLtAmiId(ltName: string, version: string): Promise<string | undefined> {
    try {
        const { LaunchTemplateVersions } = await ec2.send(
            new DescribeLaunchTemplateVersionsCommand({
                LaunchTemplateName: ltName,
                Versions: [version],
            }),
        );
        return LaunchTemplateVersions?.[0]?.LaunchTemplateData?.ImageId;
    } catch {
        return undefined;
    }
}

// =============================================================================
// Cached state — populated in beforeAll
// =============================================================================

let goldenAmiId: string | undefined;
let amiAvailable: boolean | undefined;
let amiPurposeTag: string | undefined;

/** Maps LT name → LT version string actually used by the ASG (e.g. "56") */
const ltVersions = new Map<string, string>();

/** Maps LT name → resolved AMI ID in the ASG-referenced LT version */
const ltAmiIds = new Map<string, string | undefined>();

/** Full tag map (key → value) for the current SSM Golden AMI */
const goldenAmiTags = new Map<string, string>();

/**
 * Full tag map (key → value) for the AMI referenced by each LT's default version.
 * When the LT AMI == goldenAmiId the entry shares the same populated map.
 */
const ltAmiTagMaps = new Map<string, Map<string, string>>();

/** Maps LT name → State of the AMI in its default version (e.g. 'available') */
const ltAmiStates = new Map<string, string | undefined>();

// =============================================================================
// Tests
// =============================================================================

describe('Launch Template — Golden AMI Consistency', () => {

    beforeAll(async () => {
        // 1. Read the current Golden AMI ID from SSM
        try {
            const { Parameter } = await ssm.send(
                new GetParameterCommand({ Name: GOLDEN_AMI_SSM_PATH }),
            );
            goldenAmiId = Parameter?.Value;
        } catch {
            goldenAmiId = undefined;
        }

        if (!goldenAmiId) {
            console.warn(
                `SSM parameter '${GOLDEN_AMI_SSM_PATH}' not found — ` +
                'Golden AMI not yet baked (Day-0). All assertions pass vacuously.',
            );
            return;
        }

        // 2. Resolve the LT version used by each ASG, then read the AMI from that version
        await Promise.all(
            LAUNCH_TEMPLATES.map(async ({ name, asgName }) => {
                const version = await getAsgLtVersion(asgName, name);
                ltVersions.set(name, version);
                ltAmiIds.set(name, await getLtAmiId(name, version));
            }),
        );

        // 3. Collect all unique AMI IDs to describe in one batch call
        const uniqueAmiIds = new Set<string>([goldenAmiId]);
        for (const amiId of ltAmiIds.values()) {
            if (amiId) uniqueAmiIds.add(amiId);
        }

        // 4. Describe all AMIs in a single EC2 call
        const imageMap = new Map<string, Image>();
        try {
            const { Images } = await ec2.send(
                new DescribeImagesCommand({ ImageIds: [...uniqueAmiIds] }),
            );
            for (const image of Images ?? []) {
                if (image.ImageId) imageMap.set(image.ImageId, image);
            }
        } catch {
            // imageMap stays empty; downstream tests handle missing data
        }

        // 5. Populate golden AMI health + full tag map
        const goldenImage = imageMap.get(goldenAmiId);
        amiAvailable = goldenImage?.State === 'available';
        amiPurposeTag = goldenImage?.Tags?.find((t) => t.Key === 'Purpose')?.Value;
        for (const { Key, Value } of goldenImage?.Tags ?? []) {
            if (Key && Value !== undefined) goldenAmiTags.set(Key, Value);
        }

        // 6. Populate per-LT tag maps (reuse goldenAmiTags when IDs match)
        for (const { name } of LAUNCH_TEMPLATES) {
            const ltAmiId = ltAmiIds.get(name);
            if (!ltAmiId) continue;

            if (ltAmiId === goldenAmiId) {
                ltAmiTagMaps.set(name, goldenAmiTags);
                ltAmiStates.set(name, goldenImage?.State);
                continue;
            }

            const ltImage = imageMap.get(ltAmiId);
            ltAmiStates.set(name, ltImage?.State);
            const tagMap = new Map<string, string>();
            for (const { Key, Value } of ltImage?.Tags ?? []) {
                if (Key && Value !== undefined) tagMap.set(Key, Value);
            }
            ltAmiTagMaps.set(name, tagMap);
        }
    }, 30_000);

    // =========================================================================
    // Golden AMI SSM Parameter
    // =========================================================================
    describe('Golden AMI SSM Parameter', () => {
        let ssmValue: string | typeof VACUOUS;

        beforeAll(() => {
            ssmValue = goldenAmiId ?? VACUOUS;
        });

        it('should exist with a valid AMI ID format (vacuous pass on Day-0)', () => {
            // eslint-disable-next-line jest/no-conditional-in-test
            if (ssmValue === VACUOUS) {
                return;
            }
            expect(ssmValue).toMatch(/^ami-[0-9a-f]+$/);
        });
    });

    // =========================================================================
    // AMI Health
    // =========================================================================
    describe('Golden AMI Health', () => {
        let available: boolean | typeof VACUOUS;
        let purpose: string | typeof VACUOUS;

        beforeAll(() => {
            available = goldenAmiId ? (amiAvailable ?? false) : VACUOUS;
            purpose   = goldenAmiId ? (amiPurposeTag ?? 'MISSING') : VACUOUS;
        });

        it('should be in available state', () => {
            expect([true, VACUOUS]).toContain(available);
        });

        it('should be tagged Purpose=GoldenAMI', () => {
            expect([VACUOUS, 'GoldenAMI']).toContain(purpose);
        });
    });

    // =========================================================================
    // Launch Template AMI Consistency
    //
    // Each LT must reference the same AMI ID that is in SSM.
    // A mismatch means the compute stack was not redeployed after the last
    // AMI bake — new ASG instances would launch with a stale image.
    // =========================================================================
    describe('Launch Template AMI', () => {
        it.each(LAUNCH_TEMPLATES)(
            'should use the current Golden AMI — $label ($name)',
            ({ name, label }) => {
                // eslint-disable-next-line jest/no-conditional-in-test
                if (!goldenAmiId) {
                    // Vacuous pass — no Golden AMI yet
                    return;
                }

                const ltAmiId = ltAmiIds.get(name);

                // eslint-disable-next-line jest/no-conditional-in-test
                if (ltAmiId === undefined) {
                    // LT not deployed yet — vacuous pass with warning
                    console.warn(
                        `Launch template '${name}' (${label}) not found — ` +
                        'stack may not be deployed yet. Skipping AMI check.',
                    );
                    return;
                }

                // eslint-disable-next-line jest/no-conditional-in-test
                const ltVersion = ltVersions.get(name) ?? '?';
                expect(ltAmiId).toBe(goldenAmiId);
                // eslint-disable-next-line jest/no-conditional-in-test
                if (ltAmiId !== goldenAmiId) {
                    console.error(
                        `[${label}] LT ${name} v${ltVersion} → ${ltAmiId} ` +
                        `but SSM has ${goldenAmiId}. Redeploy compute stack.`,
                    );
                }
            },
        );

        it.each(LAUNCH_TEMPLATES)(
            'should not reference a deregistered or missing AMI — $label ($name)',
            ({ name, label }) => {
                const ltAmiId = ltAmiIds.get(name);
                // eslint-disable-next-line jest/no-conditional-in-test
                if (!ltAmiId) {
                    return;
                }

                // State is pre-fetched in beforeAll via the bulk DescribeImages call
                const state = ltAmiStates.get(name);

                // eslint-disable-next-line jest/no-conditional-in-test
                if (!state) {
                    console.warn(
                        `Launch template '${name}' (${label}) references AMI ${ltAmiId} ` +
                        'which cannot be described — may be deregistered.',
                    );
                }

                // eslint-disable-next-line jest/no-conditional-in-test
                expect(state ?? 'not-found').toBe('available');
            },
        );
    });

    // =========================================================================
    // AMI Tag Consistency
    //
    // Every Golden AMI — both the current SSM version and any AMI still in use
    // by a Launch Template — must carry the same tag schema. This catches two
    // failure modes:
    //
    //  a) New AMI missing tags: the ImageBuilder pipeline was changed and forgot
    //     to carry forward required tags → new instances miss observability labels.
    //
    //  b) Old LT-referenced AMI missing tags: the previous bake was defective and
    //     the LT should be updated urgently (stale image + bad tags = double risk).
    //
    // Fixed-value tags are asserted with exact matches. Version tags (Kubernetes-,
    // Containerd-, Calico-, K8sGPT-Version) are only checked for key existence
    // because their values legitimately differ between AMI generations.
    // =========================================================================
    describe('AMI Tag Consistency', () => {

        // --- Current SSM Golden AMI ----------------------------------------

        describe('Current Golden AMI (SSM)', () => {
            it.each(Object.entries(GOLDEN_AMI_FIXED_TAGS))(
                'should have fixed tag %s=%s',
                (key, expectedValue) => {
                    // eslint-disable-next-line jest/no-conditional-in-test
                    if (!goldenAmiId) { return; }

                    const actual = goldenAmiTags.get(key);
                    expect(actual).toBe(expectedValue);
                },
            );

            it.each(GOLDEN_AMI_REQUIRED_TAG_KEYS)(
                'should have required tag key: %s',
                (key) => {
                    // eslint-disable-next-line jest/no-conditional-in-test
                    if (!goldenAmiId) { return; }

                    expect(goldenAmiTags.has(key)).toBe(true);
                },
            );
        });

        // --- LT-Referenced AMIs --------------------------------------------

        describe('LT-Referenced AMIs — fixed-value tags', () => {
            const ltFixedTagCases = LAUNCH_TEMPLATES.flatMap((lt) =>
                Object.entries(GOLDEN_AMI_FIXED_TAGS).map(([key, expectedValue]) => ({
                    ...lt,
                    tagKey: key,
                    tagValue: expectedValue,
                })),
            );

            it.each(ltFixedTagCases)(
                'should have tag $tagKey=$tagValue — $label ($name) AMI',
                ({ name, label, tagKey, tagValue }) => {
                    // eslint-disable-next-line jest/no-conditional-in-test
                    if (!goldenAmiId) { return; }

                    const ltAmiId = ltAmiIds.get(name);
                    // eslint-disable-next-line jest/no-conditional-in-test
                    if (!ltAmiId) { return; }

                    const tags = ltAmiTagMaps.get(name);
                    // eslint-disable-next-line jest/no-conditional-in-test
                    if (!tags || tags.size === 0) {
                        console.warn(
                            `No tags found for AMI ${ltAmiId} in ${label} LT — ` +
                            'bulk describe may have failed.',
                        );
                        return;
                    }

                    expect(tags.get(tagKey)).toBe(tagValue);
                },
            );
        });

        describe('LT-Referenced AMIs — required tag keys', () => {
            const ltRequiredKeyCases = LAUNCH_TEMPLATES.flatMap((lt) =>
                GOLDEN_AMI_REQUIRED_TAG_KEYS.map((key) => ({ ...lt, tagKey: key })),
            );

            it.each(ltRequiredKeyCases)(
                'should have required tag key: $tagKey — $label ($name) AMI',
                ({ name, label, tagKey }) => {
                    // eslint-disable-next-line jest/no-conditional-in-test
                    if (!goldenAmiId) { return; }

                    const ltAmiId = ltAmiIds.get(name);
                    // eslint-disable-next-line jest/no-conditional-in-test
                    if (!ltAmiId) { return; }

                    const tags = ltAmiTagMaps.get(name);
                    // eslint-disable-next-line jest/no-conditional-in-test
                    if (!tags || tags.size === 0) {
                        console.warn(
                            `No tags found for AMI ${ltAmiId} in ${label} LT — ` +
                            'bulk describe may have failed.',
                        );
                        return;
                    }

                    expect(tags.has(tagKey)).toBe(true);
                },
            );
        });
    });
});
