import { bookVerdict, memberVerdict, type MemberFacts } from './borrow-rules';

const member: MemberFacts = {
  memberCode: 'MEM-1',
  membershipStatus: 'active',
  expiryDate: '2027-01-31',
  deposit: 10,
  onLoanItems: 1,
  overdueItems: 0,
};
const shelf = {
  total: 3,
  available: 1,
  onLoan: 2,
  reserved: 0,
  nextDueAt: null,
  overdueCopies: 0,
};
const today = '2026-11-04';

describe('borrow rules', () => {
  it('lets an active, paid-up member with nothing overdue borrow a book on the shelf', () => {
    const verdict = memberVerdict(member, today);
    expect(verdict).toEqual({ canBorrow: true, reasons: [] });
    expect(bookVerdict(verdict, shelf)).toEqual({
      canBorrow: true,
      reasons: [],
    });
  });

  it('explains every reason a member cannot borrow', () => {
    const verdict = memberVerdict(
      {
        ...member,
        membershipStatus: 'pending_deposit',
        deposit: 0,
        overdueItems: 2,
      },
      today,
    );
    expect(verdict.canBorrow).toBe(false);
    expect(verdict.reasons).toEqual([
      'Your membership deposit has not been paid yet.',
      'You have 2 overdue books to return first.',
    ]);
  });

  it('treats a past expiry date as expired even if the status was not updated', () => {
    expect(
      memberVerdict({ ...member, expiryDate: '2026-11-03' }, today).reasons,
    ).toEqual(['Your membership expired on 2026-11-03.']);
  });

  it('refuses staff without a membership and books with no copy on the shelf', () => {
    expect(memberVerdict(null).canBorrow).toBe(false);
    expect(
      bookVerdict(memberVerdict(member, today), { ...shelf, available: 0 }),
    ).toEqual({
      canBorrow: false,
      reasons: ['No copy is on the shelf right now.'],
    });
  });
});
