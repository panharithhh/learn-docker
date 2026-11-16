export interface MemberFacts {
  memberCode: string;
  membershipStatus: string;
  /** YYYY-MM-DD */
  expiryDate: string;
  deposit: number;
  onLoanItems: number;
  overdueItems: number;
}

export interface CopyFacts {
  total: number;
  available: number;
  onLoan: number;
  reserved: number;
  /** Earliest due date among copies that are out and not yet late */
  nextDueAt: string | null;
  overdueCopies: number;
}

export interface Verdict {
  canBorrow: boolean;
  reasons: string[];
}

/**
 * The library's borrowing rules in one place. The chat model only phrases the
 * answer; whether someone may borrow is decided here, from live data.
 */
export function memberVerdict(
  member: MemberFacts | null,
  today = new Date().toISOString().slice(0, 10),
): Verdict {
  if (!member) {
    return {
      canBorrow: false,
      reasons: ['You do not have a library membership.'],
    };
  }
  const reasons: string[] = [];
  if (member.membershipStatus === 'blocked') {
    reasons.push('Your membership is blocked. Please talk to a librarian.');
  }
  if (member.membershipStatus === 'pending_deposit' || member.deposit <= 0) {
    reasons.push('Your membership deposit has not been paid yet.');
  }
  if (member.membershipStatus === 'expired' || member.expiryDate < today) {
    reasons.push(`Your membership expired on ${member.expiryDate}.`);
  }
  if (member.overdueItems > 0) {
    reasons.push(
      `You have ${member.overdueItems} overdue ${member.overdueItems === 1 ? 'book' : 'books'} to return first.`,
    );
  }
  return { canBorrow: reasons.length === 0, reasons };
}

export function bookVerdict(member: Verdict, copies: CopyFacts): Verdict {
  const reasons = [...member.reasons];
  if (copies.total === 0) {
    reasons.push('The library has no copies of this book.');
  } else if (copies.available === 0) {
    reasons.push('No copy is on the shelf right now.');
  }
  return { canBorrow: reasons.length === 0, reasons };
}
