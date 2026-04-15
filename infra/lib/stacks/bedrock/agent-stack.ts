/**
 * @format
 * Bedrock Agent Stack
 *
 * Core AI stack for the Bedrock Agent project.
 * Creates the Bedrock Agent, Guardrail, and Agent Alias.
 *
 * Uses @cdklabs/generative-ai-cdk-constructs for L2 Bedrock constructs.
 */

import {
    bedrock,
} from '@cdklabs/generative-ai-cdk-constructs';
import type { IKnowledgeBase } from '@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/bedrock/knowledge-bases/knowledge-base';

import * as cdkBedrock from 'aws-cdk-lib/aws-bedrock';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for BedrockAgentStack
 */
export interface BedrockAgentStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Foundation model ID (e.g. 'anthropic.claude-sonnet-4-6') */
    readonly foundationModel: string;
    /** Agent instruction prompt */
    readonly agentInstruction: string;
    /** Agent description */
    readonly agentDescription: string;
    /** Idle session timeout in seconds */
    readonly idleSessionTtlInSeconds: number;
    /** Whether to enable content filters on the guardrail */
    readonly enableContentFilters: boolean;
    /** Blocked input messaging for guardrail */
    readonly blockedInputMessaging: string;
    /** Blocked output messaging for guardrail */
    readonly blockedOutputsMessaging: string;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Optional Knowledge Base to associate with the agent */
    readonly knowledgeBase?: IKnowledgeBase;
}

/**
 * Agent Stack for Bedrock.
 *
 * Creates the Bedrock Agent with Knowledge Base, Guardrail,
 * and Agent Alias.
 */
export class BedrockAgentStack extends cdk.Stack {
    /** The Bedrock Agent */
    public readonly agent: bedrock.Agent;

    /** The Agent Alias for stable invocations */
    public readonly agentAlias: bedrock.AgentAlias;

    /** The Guardrail */
    public readonly guardrail: bedrock.Guardrail;

    /** Agent ID */
    public readonly agentId: string;

    /** Agent Alias ID */
    public readonly agentAliasId: string;

    constructor(scope: Construct, id: string, props: BedrockAgentStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // Guardrail — Content Filtering & Topic Denial
        // =================================================================
        this.guardrail = new bedrock.Guardrail(this, 'Guardrail', {
            name: `${namePrefix}-guardrail`,
            description: `Content guardrail for ${namePrefix} agent`,
            blockedInputMessaging: props.blockedInputMessaging,
            blockedOutputsMessaging: props.blockedOutputsMessaging,
        });

        // Add content filters via the method API
        if (props.enableContentFilters) {
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.SEXUAL,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.HIGH,
            });
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.VIOLENCE,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.HIGH,
            });
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.HATE,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.HIGH,
            });
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.INSULTS,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.HIGH,
            });
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.MISCONDUCT,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.HIGH,
            });
            // Gap S4 — PROMPT_ATTACK outputStrength is intentionally NONE.
            // The guardrail blocks prompt injection attempts on INPUT (strength: HIGH).
            // The model is not expected to generate attack patterns in its responses,
            // so output filtering is disabled to avoid false-positive blocks on
            // legitimate responses that discuss security concepts (e.g. explaining
            // what a prompt injection attack is when retrieved from the KB).
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.PROMPT_ATTACK,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.NONE,
            });
        }

        // =================================================================
        // Topic Denial — Block off-topic queries
        // =================================================================
        this.guardrail.addDeniedTopicFilter(
            bedrock.Topic.custom({
                name: 'OffTopicQueries',
                definition:
                    'Any question or request not related to Nelson Lamounier\'s ' +
                    'portfolio, projects, skills, certifications, AWS infrastructure, ' +
                    'career experience, or the technologies documented in the Knowledge Base.',
                examples: [
                    'What is the capital of France?',
                    'Explain how machine learning works',
                    'Help me with my homework',
                    'What is the weather today?',
                    'Tell me a joke',
                ],
            }),
        );

        this.guardrail.addDeniedTopicFilter(
            bedrock.Topic.custom({
                name: 'CodeGenerationRequests',
                definition:
                    'Requests to write, generate, debug, or refactor code that is ' +
                    'not directly documented in the Knowledge Base. The assistant ' +
                    'should not act as a general-purpose coding tool.',
                examples: [
                    'Write me a Python script to sort a list',
                    'Generate a React component for a login page',
                    'Debug this Java code for me',
                    'Create a SQL query to join these tables',
                ],
            }),
        );

        // =================================================================
        // Contextual Grounding — Ensure responses are KB-grounded
        // =================================================================
        this.guardrail.addContextualGroundingFilter({
            type: bedrock.ContextualGroundingFilterType.GROUNDING,
            threshold: 0.7,
        });
        this.guardrail.addContextualGroundingFilter({
            type: bedrock.ContextualGroundingFilterType.RELEVANCE,
            threshold: 0.7,
        });

        // =================================================================
        // Resolve Foundation Model
        //
        // If the foundationModel ID starts with a geo prefix (e.g. 'eu.'),
        // use CrossRegionInferenceProfile to create a proper inference
        // profile for the Agent. Otherwise, use the direct model ID.
        // =================================================================
        const geoMatch = props.foundationModel.match(/^(eu|us|apac)\.(.*)/);
        const agentModel = geoMatch
            ? bedrock.CrossRegionInferenceProfile.fromConfig({
                geoRegion: geoMatch[1] === 'eu'
                    ? bedrock.CrossRegionInferenceProfileRegion.EU
                    : geoMatch[1] === 'us'
                        ? bedrock.CrossRegionInferenceProfileRegion.US
                        : bedrock.CrossRegionInferenceProfileRegion.APAC,
                // Use explicit constructor so supportsCrossRegion is set to true.
                // fromCdkFoundationModelId() does not set this flag, causing the
                // CrossRegionInferenceProfile to reject newer models not yet in
                // the library's hardcoded whitelist.
                model: new bedrock.BedrockFoundationModel(geoMatch[2], {
                    supportsAgents: true,
                    supportsCrossRegion: true,
                }),
            })
            : bedrock.BedrockFoundationModel.fromCdkFoundationModelId(
                new cdkBedrock.FoundationModelIdentifier(props.foundationModel),
            );

        // =================================================================
        // Bedrock Agent
        // =================================================================
        this.agent = new bedrock.Agent(this, 'Agent', {
            name: `${namePrefix}-agent`,
            description: props.agentDescription,
            foundationModel: agentModel,
            instruction: props.agentInstruction,
            idleSessionTTL: cdk.Duration.seconds(props.idleSessionTtlInSeconds),
            forceDelete: true,
        });

        // Wire Guardrail and Knowledge Base via methods
        this.agent.addGuardrail(this.guardrail);

        // Associate Knowledge Base if provided
        if (props.knowledgeBase) {
            this.agent.addKnowledgeBase(props.knowledgeBase);
        }

        // =================================================================
        // Agent Alias — Stable identifier for invocations
        // =================================================================
        this.agentAlias = new bedrock.AgentAlias(this, 'AgentAlias', {
            agent: this.agent,
            aliasName: `${namePrefix}-live`,
            description: `Live alias for ${namePrefix} agent`,
        });

        this.agentId = this.agent.agentId;
        this.agentAliasId = this.agentAlias.aliasId;

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'AgentIdParam', {
            parameterName: `/${namePrefix}/agent-id`,
            stringValue: this.agent.agentId,
            description: `Bedrock Agent ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'AgentArnParam', {
            parameterName: `/${namePrefix}/agent-arn`,
            stringValue: this.agent.agentArn,
            description: `Bedrock Agent ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'AgentAliasIdParam', {
            parameterName: `/${namePrefix}/agent-alias-id`,
            stringValue: this.agentAlias.aliasId,
            description: `Bedrock Agent Alias ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'AgentId', {
            value: this.agent.agentId,
            description: 'Bedrock Agent ID',
        });

        new cdk.CfnOutput(this, 'AgentArn', {
            value: this.agent.agentArn,
            description: 'Bedrock Agent ARN',
        });

        new cdk.CfnOutput(this, 'AgentAliasId', {
            value: this.agentAlias.aliasId,
            description: 'Bedrock Agent Alias ID',
        });

        new cdk.CfnOutput(this, 'GuardrailId', {
            value: this.guardrail.guardrailId,
            description: 'Guardrail ID',
        });
    }
}
