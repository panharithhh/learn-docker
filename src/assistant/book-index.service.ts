import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { withSpan } from '../common/observability/with-span';
import { LlmClient, ModelRateLimitedException } from './llm.client';

interface IndexedBook {
  id: string;
  /** Lowercased title for exact-title matches like "can I borrow the little prince" */
  titleKey: string;
  titleWords: string[];
  vector: Float32Array;
}

interface BookRow {
  id: string;
  title: string;
  authors: string;
  category: string | null;
  language: string;
  publisher: string | null;
  description: string | null;
}

export interface BookMatch {
  id: string;
  score: number;
  titleMatch: boolean;
}

interface EmbeddingCache {
  model: string;
  /** sha256 of the embedded text → vector */
  vectors: Record<string, number[]>;
}

const BATCH = 20;
const RECHECK_MS = 60_000;
// Waits on the free tier's per-minute quota while indexing, then gives up until the next check
const RATE_LIMIT_RETRIES = 4;
const MAX_WAIT_MS = 65_000;
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'book',
  'books',
]);

/**
 * Semantic search over the catalog. A few hundred books fit in memory as plain
 * vectors, so a scan is sub-millisecond; pgvector only pays off far beyond that.
 * Vectors are cached on disk by content, so restarts and unchanged books cost no
 * API quota, and the index rebuilds in the background when the books table changes.
 */
@Injectable()
export class BookIndexService implements OnApplicationBootstrap {
  private readonly logger = new Logger('BookIndex');
  // Empty disables the cache (tests)
  private readonly cacheFile =
    process.env.BOOK_EMBEDDINGS_CACHE ?? '.cache/book-embeddings.json';
  private books: IndexedBook[] = [];
  private version = '';
  private checkedAt = 0;
  private building: Promise<void> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly llm: LlmClient,
  ) {}

  onApplicationBootstrap() {
    this.refreshIfStale();
  }

  /** Resolves once a build in progress has finished (tests wait on this). */
  async whenIdle() {
    await this.building;
  }

  async search(query: string, limit: number): Promise<BookMatch[]> {
    this.refreshIfStale();
    if (!this.books.length) {
      // The caller falls back to keyword search rather than making a member wait
      throw new ServiceUnavailableException('The book index is not ready yet.');
    }
    const [embedding] = await withSpan('book_index.embed_query', () =>
      this.llm.embed([`task: search result | query: ${query}`]),
    );
    const queryVector = normalize(embedding);
    const queryKey = simplify(query);
    const queryWords = new Set(words(query));

    return this.books
      .map((book) => {
        const titleMatch =
          book.titleKey.length >= 4 && queryKey.includes(book.titleKey);
        const overlap = book.titleWords.length
          ? book.titleWords.filter((word) => queryWords.has(word)).length /
            book.titleWords.length
          : 0;
        // Meaning first, with a nudge for titles typed out by name
        const score =
          dot(queryVector, book.vector) + (titleMatch ? 0.5 : overlap * 0.2);
        return { id: book.id, score, titleMatch };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Starts a rebuild in the background at most once a minute; searches keep the current index meanwhile. */
  private refreshIfStale() {
    if (this.building || Date.now() - this.checkedAt < RECHECK_MS) return;
    this.checkedAt = Date.now();
    this.building = this.refresh()
      .catch((error: Error) =>
        this.logger.warn(`Book index not updated: ${error.message}`),
      )
      .finally(() => (this.building = null));
  }

  private async refresh() {
    const [{ version }] = await this.dataSource.query<{ version: string }[]>(
      `SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at)::text, '') AS version FROM books`,
    );
    if (version === this.version && this.books.length) return;
    await withSpan('book_index.build', () => this.build());
    this.version = version;
  }

  private async build() {
    const started = performance.now();
    const rows = await this.dataSource.query<BookRow[]>(`
      SELECT b.id, b.title, b.language, b.publisher, b.description, cat.name AS category,
        COALESCE((SELECT string_agg(a.name, ', ' ORDER BY a.name)
                  FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                  WHERE ba.book_id = b.id), '') AS authors
      FROM books b LEFT JOIN categories cat ON cat.id = b.category_id
      ORDER BY b.id`);

    const texts = rows.map(documentText);
    const keys = texts.map(sha256);
    const cache = this.readCache();
    const missing = keys.flatMap((key, i) => (cache.vectors[key] ? [] : [i]));

    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      const vectors = await this.embedWithRetry(batch.map((i) => texts[i]));
      batch.forEach((i, j) => (cache.vectors[keys[i]] = vectors[j]));
      // Saved after every batch, so an interrupted build resumes where it stopped
      this.writeCache(cache);
    }

    this.books = rows.map((row, i) => ({
      id: String(row.id),
      titleKey: simplify(row.title),
      titleWords: words(row.title),
      vector: normalize(cache.vectors[keys[i]]),
    }));
    // Drop vectors of books that changed or were removed
    this.writeCache({
      model: cache.model,
      vectors: Object.fromEntries(keys.map((key) => [key, cache.vectors[key]])),
    });
    this.logger.log(
      `Indexed ${rows.length} books (${missing.length} newly embedded) in ${Math.round(performance.now() - started)}ms`,
    );
  }

  private async embedWithRetry(texts: string[]) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.llm.embed(texts);
      } catch (error) {
        if (
          !(error instanceof ModelRateLimitedException) ||
          attempt >= RATE_LIMIT_RETRIES
        ) {
          throw error;
        }
        const wait = Math.min(error.retryAfterMs, MAX_WAIT_MS);
        this.logger.warn(
          `Embedding quota reached; continuing in ${Math.round(wait / 1000)}s`,
        );
        await sleep(wait, undefined, { ref: false });
      }
    }
  }

  private readCache(): EmbeddingCache {
    const empty = { model: this.llm.embedModel, vectors: {} };
    if (!this.cacheFile) return empty;
    try {
      const cache = JSON.parse(
        readFileSync(this.cacheFile, 'utf8'),
      ) as EmbeddingCache;
      // Vectors from a different model live in a different space
      return cache.model === this.llm.embedModel ? cache : empty;
    } catch {
      return empty;
    }
  }

  private writeCache(cache: EmbeddingCache) {
    if (!this.cacheFile) return;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(cache));
    } catch (error) {
      // A read-only disk (some containers) only costs re-embedding on the next start
      this.logger.warn(
        `Embedding cache not saved: ${(error as Error).message}`,
      );
    }
  }
}

// The document format Gemini's embedding models expect for retrieval
function documentText(book: BookRow) {
  const details = [
    `${book.title} by ${book.authors || 'unknown author'}.`,
    book.category && `Category: ${book.category}.`,
    `Language: ${book.language}.`,
    book.publisher && `Publisher: ${book.publisher}.`,
    book.description,
  ];
  return `title: ${book.title} | text: ${details.filter(Boolean).join(' ')}`;
}

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

function simplify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function words(text: string) {
  return simplify(text)
    .split(' ')
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

function normalize(values: number[]) {
  const vector = Float32Array.from(values);
  let length = 0;
  for (const value of vector) length += value * value;
  length = Math.sqrt(length) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= length;
  return vector;
}

function dot(a: Float32Array, b: Float32Array) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
