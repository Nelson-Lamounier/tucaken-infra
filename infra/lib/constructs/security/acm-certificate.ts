/**
 * @format
 * ACM Certificate DNS Validation Construct
 *
 * Cross-account ACM Certificate with DNS validation.
 * Creates ACM certificate and validates via Route 53 in another account.
 *
 * Blueprint Pattern:
 * - Stack creates Lambda function and passes it as prop
 * - Construct only handles ACM certificate and custom resource orchestration
 */

import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

import { Environment, environmentRemovalPolicy } from '../../config/environments';

/**
 * Props for AcmCertificateDnsValidationConstruct
 */
export interface AcmCertificateDnsValidationConstructProps {
    /**
     * Target environment
     */
    readonly environment: Environment;

    /**
     * Domain name for the certificate
     * @example "monitoring.example.com"
     */
    readonly domainName: string;

    /**
     * Subject Alternative Names (SANs) for additional domains
     * @example ["*.monitoring.example.com"]
     * @default undefined
     */
    readonly subjectAlternativeNames?: string[];

    /**
     * Route 53 Hosted Zone ID in root account
     * @example "Z1234567890ABC"
     */
    readonly hostedZoneId: string;

    /**
     * Cross-account IAM role ARN to assume for Route 53 access
     * @example "arn:aws:iam::123456789012:role/Route53DnsValidationRole"
     */
    readonly crossAccountRoleArn: string;

    /**
     * Lambda function for DNS validation (passed from stack)
     * Stack is responsible for creating the Lambda with appropriate code
     */
    readonly validationFunction: lambda.IFunction;

    /**
     * AWS region for the certificate
     * @default Current region (from Stack)
     */
    readonly region?: string;

    /**
     * CloudFront distribution domain name for DNS alias record
     * When provided, creates an A record (Alias) pointing to CloudFront
     * @example "d1234abcd.cloudfront.net"
     */
    readonly cloudFrontDomainName?: string;

    /**
     * CloudWatch Logs retention period for custom resource provider
     * @default Based on environment config
     */
    readonly logRetention?: logs.RetentionDays;

    /**
     * Resource name prefix
     * @default 'acm'
     */
    readonly namePrefix?: string;
}

/**
 * Cross-Account ACM Certificate with DNS Validation
 *
 * Creates an ACM certificate with DNS validation when the Route 53
 * hosted zone exists in a different AWS account (typically a root/shared account).
 *
 * Blueprint Pattern:
 * - Stack creates Lambda function using LambdaFunctionConstruct
 * - Stack passes Lambda function to this construct
 * - Construct adds required IAM permissions and orchestrates custom resource
 *
 * Cross-Account Setup Requirements:
 * 1. Root account must have IAM role with Route 53 permissions
 * 2. Root account role must trust current account
 * 3. Current account Lambda must have sts:AssumeRole permission
 *
 * @example
 * ```typescript
 * // Stack creates Lambda function
 * const validationLambda = new LambdaFunctionConstruct(this, 'ValidationLambda', {
 *     functionName: 'acm-dns-validation',
 *     codePath: 'lambda/acm-dns-validation',
 *     timeout: Duration.minutes(15),
 * });
 *
 * // Stack passes Lambda to construct
 * const certificate = new AcmCertificateDnsValidationConstruct(this, 'Certificate', {
 *     environment: Environment.PRODUCTION,
 *     domainName: 'monitoring.example.com',
 *     subjectAlternativeNames: ['*.monitoring.example.com'],
 *     hostedZoneId: 'Z1234567890ABC',
 *     crossAccountRoleArn: 'arn:aws:iam::123456789012:role/Route53DnsValidationRole',
 *     validationFunction: validationLambda.function,
 * });
 * ```
 */
export class AcmCertificateDnsValidationConstruct extends Construct {
    /** Custom resource that triggers Lambda */
    public readonly customResource: cdk.CustomResource;

    /** ACM certificate ARN (available after creation) */
    public readonly certificateArn: string;

    /** Domain name for the certificate */
    public readonly domainName: string;

    /** The validation Lambda function (passed from stack) */
    public readonly validationFunction: lambda.IFunction;

    constructor(
        scope: Construct,
        id: string,
        props: AcmCertificateDnsValidationConstructProps,
    ) {
        super(scope, id);

        // Soft-fail: use annotations instead of throws.
        // CDK synth creates all stacks, so these must not block synth for
        // CI validation or non-edge deploys where edge config env vars are absent.
        if (!props.domainName) {
            cdk.Annotations.of(this).addWarning('domainName is required for ACM certificate');
        }

        if (!props.hostedZoneId) {
            cdk.Annotations.of(this).addWarning('hostedZoneId is required for DNS validation');
        }

        if (!props.crossAccountRoleArn) {
            cdk.Annotations.of(this).addWarning('crossAccountRoleArn is required for cross-account DNS');
        }

        if (!props.validationFunction) {
            throw new Error('validationFunction is required');
        }

        // ========================================
        // CONFIGURATION
        // ========================================
        const environment = props.environment;
        const namePrefix = props.namePrefix ?? 'acm';
        const region = props.region ?? cdk.Stack.of(this).region;
        const logRetention = props.logRetention ?? (
            environment === Environment.PRODUCTION
                ? logs.RetentionDays.THREE_MONTHS
                : environment === Environment.STAGING
                    ? logs.RetentionDays.ONE_MONTH
                    : logs.RetentionDays.ONE_WEEK
        );

        this.domainName = props.domainName;
        this.validationFunction = props.validationFunction;

        // ========================================
        // IAM PERMISSIONS (added to passed Lambda)
        // ========================================
        // ACM certificate management — always needed when the construct is active
        this.validationFunction.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'acm:RequestCertificate',
                    'acm:DescribeCertificate',
                    'acm:DeleteCertificate',
                    'acm:AddTagsToCertificate',
                    'acm:ListCertificates', // Required for findExistingIssuedCertificate() recovery scan
                ],
                resources: ['*'], // ACM certificates don't exist before creation
            }),
        );

        // Cross-account role assumption — only when a valid ARN is provided.
        // When crossAccountRoleArn is empty (e.g. missing env var during CI synth),
        // skip this statement to avoid IAM rejecting an empty resource string.
        if (props.crossAccountRoleArn) {
            this.validationFunction.addToRolePolicy(
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['sts:AssumeRole'],
                    resources: [props.crossAccountRoleArn],
                }),
            );
        }

        // ========================================
        // CUSTOM RESOURCE PROVIDER
        // ========================================
        const providerLogGroup = new logs.LogGroup(this, 'ProviderLogGroup', {
            logGroupName: `/aws/lambda/${namePrefix}-cert-provider-${environment}`,
            retention: logRetention,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const provider = new cr.Provider(this, 'CertificateProvider', {
            onEventHandler: this.validationFunction,
            logGroup: providerLogGroup,
        });

        // ========================================
        // CUSTOM RESOURCE
        // ========================================
        this.customResource = new cdk.CustomResource(this, 'Certificate', {
            serviceToken: provider.serviceToken,
            properties: {
                DomainName: props.domainName,
                SubjectAlternativeNames: props.subjectAlternativeNames,
                HostedZoneId: props.hostedZoneId,
                CrossAccountRoleArn: props.crossAccountRoleArn,
                Environment: environment,
                Region: region,
                CloudFrontDomainName: props.cloudFrontDomainName,
            },
            removalPolicy: environmentRemovalPolicy(environment),
        });

        // Get certificate ARN from custom resource
        this.certificateArn = this.customResource.getAttString('CertificateArn');

        // ========================================
        // OUTPUTS
        // ========================================
        new cdk.CfnOutput(this, 'CertificateArnOutput', {
            value: this.certificateArn,
            description: 'ACM certificate ARN provisioned by custom resource',
            exportName: `${namePrefix}-${environment}-certificate-arn`,
        });

        new cdk.CfnOutput(this, 'DomainNameOutput', {
            value: this.domainName,
            description: 'Certificate domain name',
        });

        // ========================================
        // CDK NAG SUPPRESSIONS
        // ========================================
        this.applyCdkNagSuppressions();
    }

    /**
     * Apply CDK Nag suppressions
     */
    private applyCdkNagSuppressions(): void {
        NagSuppressions.addResourceSuppressions(
            this.validationFunction,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'Lambda function requires wildcard permissions:\n' +
                        '1. ACM: Certificate ARNs unknown before creation\n' +
                        '2. STS: Cross-account role scoped to specific ARN',
                    appliesTo: ['Action::acm:*', 'Resource::*'],
                },
            ],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Lambda function uses Node.js 22.x which is the latest LTS runtime',
                },
            ],
            true,
        );
    }
}
