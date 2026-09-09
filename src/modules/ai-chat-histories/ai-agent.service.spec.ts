import { AiAgentService } from './ai-agent.service';
import { AgentRoute, MAX_AGENT_STEPS } from './ai-chat.constants';
import type {
  Content,
  GenerateOptions,
  GenerateResult,
  GeminiClient,
} from './gemini.client';

/** A scripted model: each entry is one turn's reply, and once the script runs out it answers with plain text, as a real model does. */
class FakeGemini implements GeminiClient {
  readonly seen: GenerateOptions[] = [];

  constructor(
    private readonly script: GenerateResult[],
    private readonly fallback: GenerateResult = text('xong'),
  ) {}

  isConfigured() {
    return true;
  }

  generate(options: GenerateOptions): Promise<GenerateResult> {
    // Snapshot the conversation: the loop mutates the array it was handed.
    this.seen.push({
      ...options,
      contents: Array.isArray(options.contents)
        ? (JSON.parse(JSON.stringify(options.contents)) as Content[])
        : options.contents,
    });
    return Promise.resolve(this.script.shift() ?? this.fallback);
  }
}

function text(value: string): GenerateResult {
  return {
    text: value,
    content: { role: 'model', parts: [{ text: value }] },
    functionCalls: [],
  };
}

function toolCall(
  name: string,
  args: Record<string, unknown> = {},
): GenerateResult {
  return {
    text: '',
    content: { role: 'model', parts: [{ functionCall: { name, args } }] },
    functionCalls: [{ name, args }],
  };
}

const question = (): Content[] => [
  { role: 'user', parts: [{ text: 'doanh thu tháng này?' }] },
];

const noTools = () => Promise.resolve({ result: null });

describe('AiAgentService.run', () => {
  it('answers without any tool when the model does not ask for one', async () => {
    const gemini = new FakeGemini([text('Chào bạn!')]);
    const agent = new AiAgentService(gemini);

    const result = await agent.run(question(), AgentRoute.GENERAL_LLM, noTools);

    expect(result).toEqual({
      answer: 'Chào bạn!',
      route: AgentRoute.GENERAL_LLM,
      steps: 1,
    });
  });

  it('feeds a tool result back and answers on the next turn', async () => {
    const gemini = new FakeGemini([
      toolCall('getRevenueOverview', { fromDate: '2026-08-01' }),
      text('Doanh thu tháng này là 12.000.000đ.'),
    ]);
    const agent = new AiAgentService(gemini);
    const calls: string[] = [];

    const result = await agent.run(
      question(),
      AgentRoute.INTERNAL_DATA,
      (name, args) => {
        calls.push(name);
        expect(args).toEqual({ fromDate: '2026-08-01' });
        return Promise.resolve({ result: { revenue: 12_000_000 } });
      },
    );

    expect(calls).toEqual(['getRevenueOverview']);
    expect(result.answer).toBe('Doanh thu tháng này là 12.000.000đ.');
    expect(result.steps).toBe(2);

    // The model's own turn must go back in before its results, or the second request has tool answers with nothing that asked for them.
    const second = gemini.seen[1].contents as Content[];
    expect(second).toHaveLength(3);
    expect(second[1].parts[0]).toHaveProperty('functionCall');
    expect(second[2]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'getRevenueOverview',
            response: { result: { result: { revenue: 12_000_000 } } },
          },
        },
      ],
    });
  });

  it('runs several tool calls from one turn together', async () => {
    const gemini = new FakeGemini([
      {
        text: '',
        content: {
          role: 'model',
          parts: [
            { functionCall: { name: 'getRevenueOverview', args: {} } },
            { functionCall: { name: 'getTopProducts', args: {} } },
          ],
        },
        functionCalls: [
          { name: 'getRevenueOverview', args: {} },
          { name: 'getTopProducts', args: {} },
        ],
      },
      text('Xong.'),
    ]);
    const agent = new AiAgentService(gemini);

    const result = await agent.run(
      question(),
      AgentRoute.INTERNAL_DATA,
      noTools,
    );

    expect(result.steps).toBe(2);
    const second = gemini.seen[1].contents as Content[];
    expect(second[2].parts).toHaveLength(2);
  });

  // A refused tool is data, not a crash: the model is told why and can say so.
  it('hands a tool failure back to the model instead of throwing', async () => {
    const gemini = new FakeGemini([
      toolCall('getRevenueOverview'),
      text('Bạn không có quyền xem báo cáo doanh thu.'),
    ]);
    const agent = new AiAgentService(gemini);

    const result = await agent.run(question(), AgentRoute.INTERNAL_DATA, () =>
      Promise.resolve({ error: 'Bạn không có quyền reports:read' }),
    );

    expect(result.answer).toBe('Bạn không có quyền xem báo cáo doanh thu.');
    const second = gemini.seen[1].contents as Content[];
    expect(JSON.stringify(second[2])).toContain('reports:read');
  });

  /** The regression this seam exists for: the old loop threw on `loopCount >= maxLoops`, discarding an answer produced on the last allowed turn. */
  it('keeps an answer produced on the very last allowed turn', async () => {
    const script = Array.from({ length: MAX_AGENT_STEPS - 1 }, () =>
      toolCall('searchProducts'),
    );
    script.push(text('Cửa hàng có 42 sản phẩm.'));

    const agent = new AiAgentService(new FakeGemini(script));
    const result = await agent.run(
      question(),
      AgentRoute.INTERNAL_DATA,
      noTools,
    );

    expect(result.steps).toBe(MAX_AGENT_STEPS);
    expect(result.answer).toBe('Cửa hàng có 42 sản phẩm.');
  });

  it('gives up when the model only ever asks for more tools', async () => {
    const never = new FakeGemini([], toolCall('searchProducts'));
    const agent = new AiAgentService(never);

    await expect(
      agent.run(question(), AgentRoute.INTERNAL_DATA, noTools),
    ).rejects.toThrow('exceeded execution loop limit');
  });

  // Custom tools and Google Search grounding cannot be armed together - that is why the classification round-trip exists.
  it('arms tools according to the route', async () => {
    const cases: [AgentRoute, boolean, boolean][] = [
      [AgentRoute.INTERNAL_DATA, true, false],
      [AgentRoute.EXTERNAL_SEARCH, false, true],
      [AgentRoute.GENERAL_LLM, false, false],
    ];

    for (const [route, hasFunctions, hasSearch] of cases) {
      const gemini = new FakeGemini([text('ok')]);
      await new AiAgentService(gemini).run(question(), route, noTools);

      expect(Boolean(gemini.seen[0].functionDeclarations)).toBe(hasFunctions);
      expect(Boolean(gemini.seen[0].googleSearch)).toBe(hasSearch);
    }
  });

  // On the other two routes no custom tools are armed, so a stray functionCall must not be executed.
  it('ignores tool calls outside the internal-data route', async () => {
    const gemini = new FakeGemini([toolCall('searchProducts')]);
    const agent = new AiAgentService(gemini);
    const runTool = jest.fn(noTools);

    const result = await agent.run(
      question(),
      AgentRoute.EXTERNAL_SEARCH,
      runTool,
    );

    expect(runTool).not.toHaveBeenCalled();
    expect(result.steps).toBe(1);
  });
});

describe('AiAgentService.classify', () => {
  it.each([
    ['INTERNAL_DATA', AgentRoute.INTERNAL_DATA],
    ['EXTERNAL_SEARCH', AgentRoute.EXTERNAL_SEARCH],
    ['GENERAL_LLM', AgentRoute.GENERAL_LLM],
  ])('reads %s out of the classifier reply', async (reply, expected) => {
    const agent = new AiAgentService(new FakeGemini([text(reply)]));
    await expect(agent.classify('', 'câu hỏi')).resolves.toBe(expected);
  });

  it('falls back to GENERAL_LLM rather than failing the question', async () => {
    const broken: GeminiClient = {
      isConfigured: () => true,
      generate: () => Promise.reject(new Error('quota exceeded')),
    };
    const agent = new AiAgentService(broken);

    await expect(agent.classify('', 'câu hỏi')).resolves.toBe(
      AgentRoute.GENERAL_LLM,
    );
  });
});
