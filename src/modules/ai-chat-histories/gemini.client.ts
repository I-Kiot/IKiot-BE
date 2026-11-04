import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { geminiModel } from './ai-chat.constants';

/** Shape transcript mà cả Gemini lẫn bộ lưu của mình dùng; `parts` là union trong API thật, còn đây là ba loại mà agent này tạo ra. */
export interface TextPart {
  text: string;
}
export interface FunctionCallPart {
  functionCall: { name: string; args?: Record<string, unknown> };
}
export interface FunctionResponsePart {
  functionResponse: { name: string; response: { result: unknown } };
}
export type ContentPart = TextPart | FunctionCallPart | FunctionResponsePart;

export interface Content {
  role: 'user' | 'model';
  parts: ContentPart[];
}

export interface GenerateOptions {
  contents: Content[] | string;
  systemInstruction?: string;
  /** Custom function tool; không dùng chung với `googleSearch` - xem AgentRoute. */
  functionDeclarations?: unknown[];
  googleSearch?: boolean;
}

export interface GenerateResult {
  /** Nội dung text của câu trả lời; rỗng khi model yêu cầu tool. */
  text: string;
  /** Lượt của model, được đưa lại vào `contents` trước khi nối kết quả tool. */
  content: Content | null;
  functionCalls: { name: string; args: Record<string, unknown> }[];
}

/** Ranh giới giữa agent và Google, để vòng lặp ReAct test được với client giả, không cần mạng hay API key. */
export abstract class GeminiClient {
  abstract isConfigured(): boolean;
  abstract generate(options: GenerateOptions): Promise<GenerateResult>;
}

function isTextPart(part: unknown): part is TextPart {
  return typeof (part as TextPart)?.text === 'string';
}

@Injectable()
export class GoogleGeminiClient extends GeminiClient {
  private readonly logger = new Logger(GoogleGeminiClient.name);
  private client: GoogleGenAI | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  /** Khởi tạo ở lần dùng đầu, không trong constructor: app phải boot được khi chưa có API key. */
  private sdk(): GoogleGenAI {
    if (!this.client) {
      this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      this.logger.log('Gemini client initialised');
    }
    return this.client;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const tools: Record<string, unknown>[] = [];
    if (options.functionDeclarations?.length) {
      tools.push({ functionDeclarations: options.functionDeclarations });
    }
    if (options.googleSearch) tools.push({ googleSearch: {} });

    const response = await this.sdk().models.generateContent({
      model: geminiModel(),
      contents: options.contents,
      config: {
        systemInstruction: options.systemInstruction,
        tools: tools.length > 0 ? tools : undefined,
      },
    });

    const candidate = response.candidates?.[0];
    const parts = (candidate?.content?.parts ?? []) as ContentPart[];

    return {
      text: parts
        .filter(isTextPart)
        .map((part) => part.text)
        .join(''),
      content: (candidate?.content as Content | undefined) ?? null,
      functionCalls: parts
        .filter((part): part is FunctionCallPart => 'functionCall' in part)
        .map((part) => ({
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
        })),
    };
  }
}
