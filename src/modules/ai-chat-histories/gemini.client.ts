import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { geminiModel } from './ai-chat.constants';

/** The transcript shape both Gemini and our own storage use; `parts` is a union in the real API, and these are the three members this agent produces. */
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
  /** Custom function tools; mutually exclusive with `googleSearch` - see AgentRoute. */
  functionDeclarations?: unknown[];
  googleSearch?: boolean;
}

export interface GenerateResult {
  /** Concatenated text of the answer, empty when the model asked for tools instead. */
  text: string;
  /** The model's turn, echoed back into `contents` before tool results are appended. */
  content: Content | null;
  functionCalls: { name: string; args: Record<string, unknown> }[];
}

/** The seam between the agent and Google, so the ReAct loop can be unit-tested against a scripted client with no network and no API key. */
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

  /** Built on first use, not in the constructor - the app must boot without an API key. */
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
