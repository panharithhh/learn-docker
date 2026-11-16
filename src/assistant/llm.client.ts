import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatStats {
  promptTokens: number;
  outputTokens: number;
}

/** What the assistant needs from a model provider. Tests provide a fake in its place. */
export abstract class LlmClient {
  abstract readonly chatModel: string;
  /** Part of the book index cache key, so switching models re-embeds the catalog */
  abstract readonly embedModel: string;
  abstract embed(texts: string[]): Promise<number[][]>;
  abstract chat(
    messages: ChatMessage[],
    onToken: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatStats>;
}

/** The free tier's per-minute quota ran out. Indexing waits it out; a member's question does not. */
export class ModelRateLimitedException extends ServiceUnavailableException {
  constructor(readonly retryAfterMs: number) {
    super(
      'The free Gemini quota is used up for the moment. Try again in about a minute.',
    );
  }
}

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
// Matryoshka embeddings: 768 of the default 3072 dimensions keep nearly all the quality
const EMBEDDING_SIZE = 768;

@Injectable()
export class GeminiClient extends LlmClient {
  private readonly logger = new Logger('Gemini');
  readonly chatModel = process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash-lite';
  readonly embedModel = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-2';

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.post(`${this.embedModel}:batchEmbedContents`, {
      requests: texts.map((text) => ({
        model: `models/${this.embedModel}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_SIZE,
      })),
    });
    const body = (await response.json()) as {
      embeddings: { values: number[] }[];
    };
    return body.embeddings.map((embedding) => embedding.values);
  }

  async chat(
    messages: ChatMessage[],
    onToken: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatStats> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const response = await this.post(
      `${this.chatModel}:streamGenerateContent?alt=sse`,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: messages
          .filter((message) => message.role !== 'system')
          .map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
        generationConfig: {
          // Room for a short answer in scripts like Khmer, which take more tokens per word
          maxOutputTokens: 512,
          // Reasoning would add seconds to short answers whose verdict is already decided
          thinkingConfig: { thinkingLevel: 'MINIMAL' },
        },
      },
      signal,
    );

    const stats: ChatStats = { promptTokens: 0, outputTokens: 0 };
    let wroteText = false;
    let blocked: string | undefined;
    for await (const chunk of readServerSentEvents<GeminiChunk>(response)) {
      if (chunk.error) throw this.failure(chunk.error.code ?? 500, chunk.error);
      blocked ??= chunk.promptFeedback?.blockReason;
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.text && !part.thought) {
          wroteText = true;
          onToken(part.text);
        }
      }
      if (chunk.usageMetadata) {
        stats.promptTokens = chunk.usageMetadata.promptTokenCount ?? 0;
        stats.outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
      }
    }
    if (!wroteText) {
      this.logger.warn(`No answer text (block reason: ${blocked ?? 'none'})`);
      throw new ServiceUnavailableException(
        'Gemini did not answer this question. Try asking it another way.',
      );
    }
    return stats;
  }

  private async post(path: string, payload: unknown, signal?: AbortSignal) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'The assistant is not set up yet: add GEMINI_API_KEY to .env (free key at https://aistudio.google.com/apikey).',
      );
    }
    let response: Response;
    try {
      response = await fetch(`${API}/${path}`, {
        method: 'POST',
        // A header, not the ?key= query, so the key never lands in URLs or logs
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      this.logger.warn(`Gemini unreachable: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Could not reach Gemini.');
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: GeminiError;
      } | null;
      throw this.failure(response.status, body?.error);
    }
    return response;
  }

  /** Maps a Gemini error to what a member should see; the details go to the server log only. */
  private failure(status: number, error?: GeminiError) {
    const detail =
      `${status} ${error?.status ?? ''} ${error?.message ?? ''}`.trim();
    if (status === 429) {
      this.logger.warn(`Rate limited: ${detail}`);
      return new ModelRateLimitedException(retryAfterMs(error));
    }
    this.logger.error(`Gemini request failed: ${detail}`);
    const keyRejected =
      status === 401 ||
      status === 403 ||
      error?.details?.some((d) => d.reason === 'API_KEY_INVALID');
    return new ServiceUnavailableException(
      keyRejected
        ? 'Gemini rejected GEMINI_API_KEY. Check the key in .env.'
        : 'Gemini is not available right now. Try again shortly.',
    );
  }
}

/** Yields each `data:` payload of a server-sent event stream as parsed JSON. */
async function* readServerSentEvents<T>(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = done ? '' : events.pop()!;
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data) yield JSON.parse(data) as T;
    }
    if (done) return;
  }
}

function retryAfterMs(error?: GeminiError) {
  const delay = error?.details?.find((d) => d.retryDelay)?.retryDelay;
  const seconds = delay ? Number.parseFloat(delay) : NaN;
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : 60_000;
}

interface GeminiError {
  code?: number;
  status?: string;
  message?: string;
  details?: { reason?: string; retryDelay?: string }[];
}

interface GeminiChunk {
  error?: GeminiError;
  promptFeedback?: { blockReason?: string };
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}
