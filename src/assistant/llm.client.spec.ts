import { ServiceUnavailableException } from '@nestjs/common';
import { GeminiClient, ModelRateLimitedException } from './llm.client';

const encoder = new TextEncoder();
const stream = (...chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe('GeminiClient', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('streams answer text, skips thoughts and reports token usage', async () => {
    fetchMock.mockResolvedValue(
      stream(
        'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true},{"text":"Yes, "}]}}]}\r\n\r\n',
        // An event can arrive split across network chunks
        'data: {"candidates":[{"content":{"parts":[{"text":"you can."}]}}],',
        '"usageMetadata":{"promptTokenCount":420,"candidatesTokenCount":5}}\n\n',
      ),
    );
    const tokens: string[] = [];
    const stats = await new GeminiClient().chat(
      [
        { role: 'system', content: 'Rules' },
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Can I borrow Hamlet?' },
      ],
      (text) => tokens.push(text),
    );

    expect(tokens.join('')).toBe('Yes, you can.');
    expect(stats).toEqual({ promptTokens: 420, outputTokens: 5 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse',
    );
    expect(url as string).not.toContain('test-key');
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'test-key' });
    expect(JSON.parse(init!.body as string)).toMatchObject({
      systemInstruction: { parts: [{ text: 'Rules' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Earlier question' }] },
        { role: 'model', parts: [{ text: 'Earlier answer' }] },
        { role: 'user', parts: [{ text: 'Can I borrow Hamlet?' }] },
      ],
      generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL' } },
    });
  });

  it('embeds a batch at 768 dimensions with the configured model', async () => {
    fetchMock.mockResolvedValue(
      json(200, { embeddings: [{ values: [1, 0] }, { values: [0, 1] }] }),
    );
    const vectors = await new GeminiClient().embed(['a', 'b']);

    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/models\/gemini-embedding-2:batchEmbedContents$/);
    expect(JSON.parse(init!.body as string).requests[1]).toEqual({
      model: 'models/gemini-embedding-2',
      content: { parts: [{ text: 'b' }] },
      outputDimensionality: 768,
    });
  });

  it('turns a 429 into a rate-limit error carrying the suggested wait', async () => {
    fetchMock.mockResolvedValue(
      json(429, {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          details: [{ retryDelay: '37s' }],
        },
      }),
    );
    const error = await new GeminiClient().embed(['a']).catch((e) => e);

    expect(error).toBeInstanceOf(ModelRateLimitedException);
    expect(error.retryAfterMs).toBe(37_000);
  });

  it('explains a rejected key without echoing Google’s error to members', async () => {
    fetchMock.mockResolvedValue(
      json(400, {
        error: {
          code: 400,
          message: 'API key not valid.',
          details: [{ reason: 'API_KEY_INVALID' }],
        },
      }),
    );

    await expect(new GeminiClient().embed(['a'])).rejects.toThrow(
      'Gemini rejected GEMINI_API_KEY. Check the key in .env.',
    );
  });

  it('asks for a key instead of calling Gemini when none is set', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');

    const error = await new GeminiClient().embed(['a']).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toMatch(/add GEMINI_API_KEY to \.env/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails clearly when the stream ends without any answer text', async () => {
    fetchMock.mockResolvedValue(
      stream('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n'),
    );

    await expect(
      new GeminiClient().chat([{ role: 'user', content: 'Hi' }], () => {}),
    ).rejects.toThrow('Gemini did not answer this question');
  });
});
