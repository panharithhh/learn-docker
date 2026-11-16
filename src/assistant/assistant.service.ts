import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../auth/types/auth-user';
import { MetricsService } from '../common/observability/metrics.service';
import { withSpan } from '../common/observability/with-span';
import { BookIndexService, type BookMatch } from './book-index.service';
import {
  bookVerdict,
  memberVerdict,
  type CopyFacts,
  type MemberFacts,
  type Verdict,
} from './borrow-rules';
import { LlmClient, type ChatMessage, type ChatStats } from './llm.client';
import { buildMessages } from './prompt';

export interface BookResult extends CopyFacts, Verdict {
  id: string;
  title: string;
  authors: string;
  category: string | null;
  language: string;
  score: number;
  titleMatch: boolean;
}

export interface Lookup {
  /** `keyword` when the embedding model is down: availability still works, matching is cruder */
  mode: 'semantic' | 'keyword';
  member: MemberFacts | null;
  memberVerdict: Verdict;
  books: BookResult[];
}

export type AssistantEvent =
  | { type: 'books'; data: Lookup }
  | { type: 'token'; data: { text: string } }
  | {
      type: 'done';
      data: ChatStats & {
        retrieveMs: number;
        firstTokenMs: number | null;
        totalMs: number;
      };
    };

// A copy counts as out with a member until it is returned
const OUT = `li.returned_at IS NULL AND li.status IN ('borrowed', 'overdue')`;
// Books from the member's previous question kept in view for a follow-up
const FOLLOW_UP_BOOKS = 2;
// Words of the question itself, which would match half the catalog in a keyword search
const QUESTION_WORDS = new Set(
  'the and for can borrow book books have you any anything about with from what which this that there are does read want like available shelf'.split(
    ' ',
  ),
);

/** The current question's matches first, then the earlier question's best ones not already listed. */
function mergeMatches(current: BookMatch[], earlier: BookMatch[]) {
  const seen = new Set(current.map((match) => match.id));
  return [...current, ...earlier.filter((match) => !seen.has(match.id))];
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger('Assistant');

  constructor(
    private readonly dataSource: DataSource,
    private readonly index: BookIndexService,
    private readonly llm: LlmClient,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Finds the books a question is about and whether this user can borrow each one, from live data.
   * `earlierQuestion` keeps a follow-up ("when is it back?") tied to the book asked about before.
   */
  async lookup(
    user: AuthUser,
    query: string,
    limit = 5,
    earlierQuestion?: string,
  ): Promise<Lookup> {
    let mode: Lookup['mode'] = 'semantic';
    let matches: BookMatch[];
    try {
      matches = await withSpan('assistant.search', async () => {
        const [current, earlier] = await Promise.all([
          this.index.search(query, limit),
          earlierQuestion
            ? this.index.search(earlierQuestion, FOLLOW_UP_BOOKS)
            : [],
        ]);
        return mergeMatches(current, earlier);
      });
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      this.logger.warn(`Falling back to keyword search: ${error.message}`);
      mode = 'keyword';
      matches = await this.keywordSearch(query, limit);
    }

    const [member, copies] = await withSpan('assistant.facts', () =>
      Promise.all([
        this.memberFacts(user.id),
        this.bookFacts(matches.map((m) => m.id)),
      ]),
    );
    const verdict = memberVerdict(member);
    const books = matches.flatMap((match) => {
      const book = copies.get(match.id);
      return book
        ? [
            {
              ...book,
              ...bookVerdict(verdict, book),
              score: +match.score.toFixed(3),
              titleMatch: match.titleMatch,
            },
          ]
        : [];
    });
    return { mode, member, memberVerdict: verdict, books };
  }

  async answer(
    user: AuthUser,
    question: string,
    history: ChatMessage[],
    emit: (event: AssistantEvent) => void,
    signal?: AbortSignal,
  ) {
    const started = performance.now();
    const earlierQuestion = history.findLast(
      (message) => message.role === 'user',
    )?.content;
    const lookup = await this.lookup(user, question, 5, earlierQuestion);
    const retrieveMs = performance.now() - started;
    emit({ type: 'books', data: lookup });

    let firstTokenMs: number | null = null;
    const stats = await withSpan(
      'assistant.generate',
      () =>
        this.llm.chat(
          buildMessages(question, lookup, history),
          (text) => {
            firstTokenMs ??= performance.now() - started;
            emit({ type: 'token', data: { text } });
          },
          signal,
        ),
      { 'gen_ai.request.model': this.llm.chatModel },
    );
    const totalMs = performance.now() - started;

    const { assistantSeconds, assistantTokens } = this.metrics;
    assistantSeconds.observe({ phase: 'retrieve' }, retrieveMs / 1000);
    if (firstTokenMs !== null)
      assistantSeconds.observe({ phase: 'first_token' }, firstTokenMs / 1000);
    assistantSeconds.observe({ phase: 'total' }, totalMs / 1000);
    assistantTokens.inc({ kind: 'prompt' }, stats.promptTokens);
    assistantTokens.inc({ kind: 'output' }, stats.outputTokens);

    emit({
      type: 'done',
      data: { ...stats, retrieveMs, firstTokenMs, totalMs },
    });
  }

  private async keywordSearch(
    query: string,
    limit: number,
  ): Promise<BookMatch[]> {
    const patterns = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3 && !QUESTION_WORDS.has(word))
      .map((word) => `%${word}%`);
    if (!patterns.length) return [];
    // Books matching more of the words rank first; a title hit counts double an author hit
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM (
         SELECT b.id, b.title,
           2 * (SELECT COUNT(*) FROM unnest($1::text[]) p WHERE b.title ILIKE p) +
           (SELECT COUNT(*) FROM unnest($1::text[]) p
            WHERE EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                          WHERE ba.book_id = b.id AND a.name ILIKE p)) AS hits
         FROM books b) ranked
       WHERE hits > 0
       ORDER BY hits DESC, title LIMIT $2`,
      [patterns, limit],
    );
    return rows.map((row) => ({
      id: String(row.id),
      score: 0,
      titleMatch: false,
    }));
  }

  private async memberFacts(userId: string): Promise<MemberFacts | null> {
    const [member] = await this.dataSource.query<MemberFacts[]>(
      `SELECT m.member_code AS "memberCode", m.membership_status AS "membershipStatus",
         m.expiry_date::text AS "expiryDate", m.deposit_amount::float AS deposit,
         (SELECT COUNT(*) FROM loans l JOIN loan_items li ON li.loan_id = l.id
          WHERE l.member_id = m.id AND ${OUT})::int AS "onLoanItems",
         (SELECT COUNT(*) FROM loans l JOIN loan_items li ON li.loan_id = l.id
          WHERE l.member_id = m.id AND ${OUT} AND li.due_date < now())::int AS "overdueItems"
       FROM members m WHERE m.user_id = $1`,
      [userId],
    );
    return member ?? null;
  }

  private async bookFacts(ids: string[]) {
    if (!ids.length)
      return new Map<
        string,
        Omit<BookResult, keyof Verdict | 'score' | 'titleMatch'>
      >();
    const rows = await this.dataSource.query<
      Omit<BookResult, keyof Verdict | 'score' | 'titleMatch'>[]
    >(
      `SELECT b.id, b.title, b.language, cat.name AS category,
         COALESCE((SELECT string_agg(a.name, ', ' ORDER BY a.name)
                   FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                   WHERE ba.book_id = b.id), '') AS authors,
         COUNT(c.id) FILTER (WHERE c.status <> 'lost')::int AS total,
         COUNT(c.id) FILTER (WHERE c.status = 'available')::int AS available,
         COUNT(c.id) FILTER (WHERE c.status = 'borrowed')::int AS "onLoan",
         COUNT(c.id) FILTER (WHERE c.status = 'reserved')::int AS reserved,
         (SELECT MIN(li.due_date) FROM loan_items li JOIN book_copies c2 ON c2.id = li.book_copy_id
          WHERE c2.book_id = b.id AND ${OUT} AND li.due_date >= now()) AS "nextDueAt",
         (SELECT COUNT(*) FROM loan_items li JOIN book_copies c2 ON c2.id = li.book_copy_id
          WHERE c2.book_id = b.id AND ${OUT} AND li.due_date < now())::int AS "overdueCopies"
       FROM books b
       LEFT JOIN categories cat ON cat.id = b.category_id
       LEFT JOIN book_copies c ON c.book_id = b.id
       WHERE b.id = ANY($1::bigint[])
       GROUP BY b.id, cat.name`,
      [ids],
    );
    return new Map(
      rows.map((row) => [String(row.id), { ...row, id: String(row.id) }]),
    );
  }
}
