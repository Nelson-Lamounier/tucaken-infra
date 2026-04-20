/**
 * @format
 * Research Handler — Step Functions Entry Point
 *
 * Lambda handler invoked by Step Functions as the first stage
 * in the multi-agent pipeline. Receives the PipelineContext,
 * executes the Research Agent, and returns the result for the
 * Writer Handler.
 *
 * Input: { context: PipelineContext }
 * Output: { context: PipelineContext, research: AgentResult<ResearchResult> }
 */

import { executeResearchAgent } from '../agents/research-agent.js';
import { log } from '../../../shared/src/index.js';
import type { ResearchHandlerInput, WriterHandlerInput } from '../../../shared/src/index.js';

/**
 * Lambda handler for the Research Agent.
 *
 * @param event - Step Functions input with PipelineContext
 * @returns Updated context and research result for the Writer stage
 */
export const handler = async (event: ResearchHandlerInput): Promise<WriterHandlerInput> => {
    log('INFO', 'Research handler invoked', { handler: 'research', pipelineId: event.context.pipelineId, slug: event.context.slug });

    const research = await executeResearchAgent(event.context);

    return {
        context: event.context,
        research,
    };
};
