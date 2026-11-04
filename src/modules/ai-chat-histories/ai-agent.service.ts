import { Injectable, Logger } from '@nestjs/common';
import {
  AgentRoute,
  MAX_AGENT_STEPS,
  SYSTEM_INSTRUCTION,
  classificationPrompt,
} from './ai-chat.constants';
import { TOOL_DECLARATIONS } from './ai-tool-declarations';
import { GeminiClient, type Content } from './gemini.client';

/** Hàm truy cập dữ liệu shop do caller cung cấp. */
export interface ToolRunner {
  (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: unknown } | { error: string }>;
}

export interface AgentResult {
  answer: string;
  route: AgentRoute;
  /** Số lượt model đã dùng, mỗi request một lượt; 1 nghĩa là trả lời không cần tool. */
  steps: number;
}

/** Vòng lặp ReAct, port từ thân `AIService.chat` và tách riêng để test được với `GeminiClient` giả. */
@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);

  constructor(private readonly gemini: GeminiClient) {}

  isConfigured(): boolean {
    return this.gemini.isConfigured();
  }

  /** Xác định câu hỏi thuộc nhóm nào; lỗi thì rơi về GENERAL_LLM, nhóm này không bật tool nhưng vẫn trả lời được. */
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

  /** Chạy hội thoại đến khi có câu trả lời. Điều kiện thoát là một cờ, không phải bộ đếm bước: vòng lặp cũ bỏ câu trả lời đến ở lượt cho phép cuối. */
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

      // Tool call chỉ có nghĩa ở route INTERNAL_DATA; ở route khác, mọi thứ model trả về là câu trả lời.
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

        // Lượt của model phải được đưa vào trước kết quả tool, nếu không request sau có tool answer không có call tương ứng.
        if (response.content) contents.push(response.content);
        contents.push({ role: 'user', parts: responses });
        continue;
      }

      return { answer: response.text, route, steps };
    }

    throw new Error('AI agent exceeded execution loop limit.');
  }
}
