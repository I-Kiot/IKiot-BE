import { phoneSearchTerms } from './phone-search';

describe('phoneSearchTerms', () => {
  it('returns the digits of a plain number, plus its country-code form', () => {
    expect(phoneSearchTerms('0912345678')).toEqual([
      '0912345678',
      '84912345678',
    ]);
  });

  it('ignores spaces, dots, dashes and brackets', () => {
    expect(phoneSearchTerms('091 234 5678')).toContain('0912345678');
    expect(phoneSearchTerms('091.234.5678')).toContain('0912345678');
    expect(phoneSearchTerms('(028) 3822-1234')).toContain('02838221234');
  });

  it('turns +84 and 84 into the leading-zero form', () => {
    expect(phoneSearchTerms('+84 912 345 678')).toEqual([
      '84912345678',
      '0912345678',
    ]);
    expect(phoneSearchTerms('84912345678')).toContain('0912345678');
  });

  it('keeps a partial number so searching by a prefix or the last digits works', () => {
    expect(phoneSearchTerms('912345')).toEqual(['912345']);
    expect(phoneSearchTerms('0912')).toContain('0912');
  });

  it('leaves names and codes alone', () => {
    expect(phoneSearchTerms('Trần Thị Khách')).toEqual([]);
    expect(phoneSearchTerms('ORD1234ABC')).toEqual([]);
    expect(phoneSearchTerms('HD000009')).toEqual([]);
    expect(phoneSearchTerms('0912abc')).toEqual([]);
  });

  it('ignores a search too short to be a phone number', () => {
    expect(phoneSearchTerms('09')).toEqual([]);
    expect(phoneSearchTerms('')).toEqual([]);
  });
});
