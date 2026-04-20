/**
 * @format
 * Research Handler — Step Functions Entry Point
 *
 * Lambda handler invoked by Step Functions as the first stage
 * in the strategist pipeline. Receives the StrategistPipelineContext,
 * executes the Research Agent, and returns the result for the
 * Strategist Handler.
 *
 * Input: { context: StrategistPipelineContext }
 * Output: { context: StrategistPipelineContext, research: AgentResult<StrategistResearchResult> }
 */

import { executeResearchAgent } from '../agents/research-agent.js';
import type {
    StrategistResearchHandlerInput,
    StrategistWriterHandlerInput,
} from '../../../shared/src/index.js';

import { log } from '../../../shared/src/index.js';

/**
 * Lambda handler for the Strategist Research Agent.
 *
 * @param event - Step Functions input with StrategistPipelineContext
 * @returns Updated context and research result for the Strategist stage
 */
export const handler = async (
    event: StrategistResearchHandlerInput,
): Promise<StrategistWriterHandlerInput> => {
    if (!event?.context?.pipelineId) {
        throw new Error(
            '[strategist-research-handler] Invalid Step Functions event: "context.pipelineId" is missing. ' +
            'This handler must be invoked by the Analysis State Machine, not directly.',
        );
    }

    log('INFO', 'Research stage started', {
        handler: 'strategist-research-handler', pipelineId: event.context.pipelineId,
        targetRole: event.context.targetRole,
    });

    const research = await executeResearchAgent(event.context);

    return {
        context: event.context,
        research,
    };
};
