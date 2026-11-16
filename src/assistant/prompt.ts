import type { ChatMessage } from './llm.client';
import type { BookResult, Lookup } from './assistant.service';

// Sent as Gemini's system instruction, the same for every question
export const SYSTEM_PROMPT = `You are the LibraFlow library assistant, talking to a library member.
Answer only from the LIBRARY DATA in the latest message. It is live and correct.
- For "can I borrow ...?", give the verdict listed for that book (yes or no) and its reasons. Never guess.
- If no listed book is what they asked for, say the library does not seem to have it, then offer the closest listed books.
- Say how many copies are on the shelf. When none are, give the date the next copy is due back if one is listed.
- Only recommend books from the list.
- Reply in the language of the question, in under 120 words, as plain sentences or a short list. No tables.`;

export function buildMessages(
  question: string,
  lookup: Lookup,
  history: ChatMessage[],
): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    {
      role: 'user',
      content: `${libraryData(lookup)}\n\nQUESTION\n${question}`,
    },
  ];
}

function libraryData({ member, memberVerdict, books }: Lookup) {
  const lines = ['LIBRARY DATA'];
  if (member) {
    // No member code or name: on Gemini's free tier, prompts may be used to improve Google's products
    lines.push(
      `Member: membership ${member.membershipStatus.replace('_', ' ')} until ${member.expiryDate}, ` +
        `${member.onLoanItems} on loan, ${member.overdueItems} overdue. ` +
        `Can borrow now: ${verdictText(memberVerdict.canBorrow, memberVerdict.reasons)}`,
    );
  } else {
    lines.push(
      `Member: none. Can borrow now: ${verdictText(false, memberVerdict.reasons)}`,
    );
  }
  lines.push(
    books.length
      ? 'Matching books, best first:'
      : 'Matching books: none found.',
  );
  books.forEach((book, i) => lines.push(`${i + 1}. ${bookLine(book)}`));
  return lines.join('\n');
}

function bookLine(book: BookResult) {
  const about = [book.category, book.language].filter(Boolean).join(', ');
  let shelf = `${book.available} of ${book.total} copies on the shelf`;
  if (book.available === 0 && book.nextDueAt)
    shelf += `, next copy due back ${shortDate(book.nextDueAt)}`;
  else if (book.available === 0 && book.overdueCopies)
    shelf += ', copies out are overdue so return dates are unknown';
  return (
    `"${book.title}"${book.authors ? ` by ${book.authors}` : ''} (${about}): ${shelf}. ` +
    `Borrow it: ${verdictText(book.canBorrow, book.reasons)}`
  );
}

function verdictText(canBorrow: boolean, reasons: string[]) {
  return canBorrow ? 'yes' : `no (${reasons.join(' ')})`;
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
