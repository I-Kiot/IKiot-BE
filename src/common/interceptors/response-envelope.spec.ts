import { StreamableFile } from '@nestjs/common';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

/** Stands in for the class instances that really reach the interceptor; the `data` field is the case the prototype check exists for. */
class Money {
  constructor(public readonly data: number) {}
  total() {
    return this.data;
  }
}

/** `wrap` is private, but every endpoint's response shape depends on it, so it is tested directly rather than through thirty-four routes. */
const wrap = (body: unknown): unknown =>
  (
    new ResponseEnvelopeInterceptor(null as never) as unknown as {
      wrap(body: unknown): unknown;
    }
  ).wrap(body);

describe('ResponseEnvelopeInterceptor.wrap', () => {
  it('wraps an entity under `data`', () => {
    expect(wrap({ id: 'abc', name: 'Áo thun' })).toEqual({
      success: true,
      data: { id: 'abc', name: 'Áo thun' },
    });
  });

  it('wraps an array under `data` rather than spreading it', () => {
    expect(wrap([1, 2])).toEqual({ success: true, data: [1, 2] });
  });

  // Why the merge branch exists: nesting would push every client from body.data[0] to body.data.data[0].
  it('merges a paginated result instead of nesting it', () => {
    expect(
      wrap({ data: [{ id: 'a' }], pagination: { total: 1, page: 1 } }),
    ).toEqual({
      success: true,
      data: [{ id: 'a' }],
      pagination: { total: 1, page: 1 },
    });
  });

  it('merges a handler that already returns its own message and data', () => {
    expect(
      wrap({ message: 'Đã cập nhật', data: { id: 'a' }, extra: 1 }),
    ).toEqual({
      success: true,
      message: 'Đã cập nhật',
      data: { id: 'a' },
      extra: 1,
    });
  });

  it('leaves a bare { success: true } alone', () => {
    expect(wrap({ success: true })).toEqual({ success: true });
  });

  it("does not overwrite a handler's own success: false", () => {
    expect(wrap({ success: false, message: 'Unknown API key' })).toEqual({
      success: false,
      message: 'Unknown API key',
    });
  });

  it('answers { success: true } for a handler that returns nothing', () => {
    expect(wrap(undefined)).toEqual({ success: true });
    expect(wrap(null)).toEqual({ success: true });
  });

  // A class instance carries behaviour a spread would strip, so the merge branch checks the prototype.
  it('treats class instances as payloads, not as envelopes', () => {
    const date = new Date('2026-08-26T00:00:00.000Z');
    expect(wrap(date)).toEqual({ success: true, data: date });

    const money = new Money(12.5);
    const wrapped = wrap(money) as { data: Money };
    expect(wrapped.data).toBeInstanceOf(Money);
    expect(wrapped.data.total()).toBe(12.5);
  });

  it('passes a file stream straight through', () => {
    const file = new StreamableFile(Buffer.from('x'));
    expect(wrap(file)).toBe(file);
  });
});
