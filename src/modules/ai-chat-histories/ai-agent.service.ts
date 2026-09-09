import { Injectable, Logger } from '@nestjs/common';
import {
  AgentRoute,
  MAX_AGENT_STEPS,
  SYSTEM_INSTRUCTION,
  classificationPrompt,
} from './ai-chat.constants';
import { TOOL_DECLARATIONS } from './ai-tool-declarations';
import { GeminiClient, type Content } from './gemini.client';

/** What the agent needs to reach the shop's data, supplied by the caller. */
export interface ToolRunner {
  (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: unknown } | { error: string }>;
}

export interface AgentResult {
  answer: string;
  route: AgentRoute;
  /** Model turns consumed - one per request, so 1 means it answered without any tool. */
  steps: number;
}

/** The ReAct loop, ported from the body of `AIService.chat` and split out so it can be tested against a scripted `GeminiClient`. */
@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);

  constructor(private readonly gemini: GeminiClient) {}

  isConfigured(): boolean {
    return this.gemini.isConfigured();
  }

  /** Decide which of the three worlds a question belongs to; a failure falls back to GENERAL_LLM, which arms no tools and still answers. */
  async classify(historyText: string, message: string): Promise<AgentRoute> {
    try {
      const { text } = await this.gemini.generate({
        contents: classificationPrompt(historyText, message),
      });
      const answer = text.trim();
      if (answer.includes(AgentRoute.INTERNAL_DATA)) {
        return AgentRoute.INTERNAL_DATA;
      }
      if (answer.includes(AgentRoute.EXTERNAL_SEARCH)) {
        return AgentRoute.EXTERNAL_SEARCH;
      }
    } catch (error) {
      this.logger.warn(
        `Intent routing failed, falling back to GENERAL_LLM: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return AgentRoute.GENERAL_LLM;
  }

  /** Run the conversation to an answer. The exit condition is a flag, not the step counter - the old loop discarded an answer that arrived on its last allowed turn. */
  async run(
    contents: Content[],
    route: AgentRoute,
    runTool: ToolRunner,
  ): Promise<AgentResult> {
    const options = {
      systemInstruction: SYSTEM_INSTRUCTION,
      functionDeclarations:
        route === AgentRoute.INTERNAL_DATA ? TOOL_DECLARATIONS : undefined,
      googleSearch: route === AgentRoute.EXTERNAL_SEARCH,
    };

    let steps = 0;
    while (steps < MAX_AGENT_STEPS) {
      steps++;

      const response = await this.gemini.generate({ ...options, contents });

      // Tool calls only mean anything on the internal-data route; elsewhere whatever the model returns is the answer.
      if (
        route === AgentRoute.INTERNAL_DATA &&
        response.functionCalls.length > 0
      ) {
        const responses = await Promise.all(
          response.functionCalls.map(async (call) => {
            this.logger.debug(`Calling tool ${call.name}`);
            const outcome = await runTool(call.name, call.args);
            return {
              functionResponse: {
                name: call.name,
                response: { result: outcome },
              },
            };
          }),
        );

        // The model's own turn has to go back in before its results, or the next request has tool answers with nothing that asked for them.
        if (response.content) contents.push(response.content);
        contents.push({ role: 'user', parts: responses });
        continue;
      }

      return { answer: response.text, route, steps };
    }

    throw new Error('AI agent exceeded execution loop limit.');
  }
}
