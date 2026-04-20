/**
 * @format
 * Writer Handler — Step Functions Entry Point
 *
 * Lambda handler invoked by Step Functions as the second stage
 * in the multi-agent pipeline. Receives the Research result and
 * PipelineContext, executes the Writer Agent, and returns the
 * result for the QA Handler.
 *
 * Input: { context: PipelineContext, research: AgentResult<ResearchResult> }
 * Output: { context: PipelineContext, research: ..., writer: AgentResult<WriterResult> }
 */

import { executeWriterAgent } from '../agents/writer-agent.js';
import { log } from '../../../shared/src/index.js';
import type { QaHandlerInput, WriterHandlerInput } from '../../../shared/src/index.js';

/**
 * Lambda handler for the Writer Agent.
 *
 * @param event - Step Functions input with context and research result
 * @returns Updated context, research, and writer result for the QA stage
 */
export const handler = async (event: WriterHandlerInput): Promise<QaHandlerInput> => {
    log('INFO', 'Writer handler invoked', {
        handler: 'writer',
        pipelineId: event.context.pipelineId,
        slug: event.context.slug,
        complexity: event.research.data.complexity.tier,
    });

    const writer = await executeWriterAgent(event.context, event.research.data);

    return {
        context: event.context,
        research: event.research,
        writer,
    };
};
