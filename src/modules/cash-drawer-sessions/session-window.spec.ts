import { isOverdue, sessionWindow } from './session-window';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('sessionWindow', () => {
  const createdAt = new Date('2026-11-10T01:00:00.000Z'); // 08:00 giờ VN

  it('runs from opening to closing once closed', () => {
    const closedAt = new Date('2026-11-11T02:00:00.000Z');
    expect(sessionWindow({ createdAt, closedAt })).toEqual({
      start: createdAt,
      end: closedAt,
    });
  });

  it('runs to now while still open - a late close is just a long session', () => {
    const now = new Date('2026-11-11T05:00:00.000Z');
    expect(sessionWindow({ createdAt, closedAt: null }, now)).toEqual({
      start: createdAt,
      end: now,
    });
  });
});

describe('isOverdue', () => {
  const open = (businessDate: Date) => ({ status: 'OPEN', businessDate });

  it('is false on the trading day the drawer belongs to', () => {
    // 23:59 giờ VN ngày 10/11
    const now = new Date('2026-11-10T16:59:00.000Z');
    expect(isOverdue(open(day('2026-11-10')), now)).toBe(false);
  });

  it('turns true at local midnight, not UTC midnight', () => {
    // 00:01 giờ VN ngày 11/11 = 17:01 UTC ngày 10/11
    const now = new Date('2026-11-10T17:01:00.000Z');
    expect(isOverdue(open(day('2026-11-10')), now)).toBe(true);
  });

  it('is false once closed, however old', () => {
    const now = new Date('2026-11-20T03:00:00.000Z');
    expect(
      isOverdue({ status: 'CLOSED', businessDate: day('2026-11-10') }, now),
    ).toBe(false);
  });
});
