import { validateVietnamIdentificationId } from './vietnam-identification';

// 079 = TP.HCM. Digit 4: 0 = male born 1900s, 1 = female born 1900s, 2 = male born 2000s.
const MALE_1995 = '079095001234';
const FEMALE_1995 = '079195001234';
const MALE_2001 = '079201001234';

// The point is catching a typo at data-entry time: the CCCD, birth date and sex all end up in payroll and social-insurance exports, where a mismatch is somebody else's problem.
describe('validateVietnamIdentificationId', () => {
  it('accepts a well-formed number with no profile to cross-check', () => {
    expect(validateVietnamIdentificationId(MALE_1995)).toBe(MALE_1995);
  });

  it('trims surrounding whitespace', () => {
    expect(validateVietnamIdentificationId(`  ${MALE_1995} `)).toBe(MALE_1995);
  });

  it.each([
    ['rỗng', '   '],
    ['có chữ', '07909500123a'],
    ['thiếu chữ số', '07909500123'],
    ['thừa chữ số', '0790950012345'],
    ['mã tỉnh không có thật', '999095001234'],
  ])('rejects a number that is %s', (_label, value) => {
    expect(() => validateVietnamIdentificationId(value)).toThrow();
  });

  it('accepts a birth year that matches the number', () => {
    expect(
      validateVietnamIdentificationId(MALE_1995, { dob: '1995-06-02' }),
    ).toBe(MALE_1995);
  });

  it('rejects a birth year that contradicts the number', () => {
    expect(() =>
      validateVietnamIdentificationId(MALE_1995, { dob: '1996-06-02' }),
    ).toThrow();
  });

  it('reads the century off digit 4', () => {
    expect(
      validateVietnamIdentificationId(MALE_2001, { dob: '2001-01-01' }),
    ).toBe(MALE_2001);
    expect(() =>
      validateVietnamIdentificationId(MALE_2001, { dob: '1901-01-01' }),
    ).toThrow();
  });

  it('rejects a sex that contradicts the number', () => {
    expect(() =>
      validateVietnamIdentificationId(MALE_1995, { gender: 'FEMALE' }),
    ).toThrow();
    expect(() =>
      validateVietnamIdentificationId(FEMALE_1995, { gender: 'MALE' }),
    ).toThrow();
  });

  it('leaves OTHER alone - the number only encodes two', () => {
    expect(
      validateVietnamIdentificationId(MALE_1995, { gender: 'OTHER' }),
    ).toBe(MALE_1995);
  });

  it('skips the date check when there is no date on record', () => {
    expect(
      validateVietnamIdentificationId(MALE_1995, { dob: null, gender: null }),
    ).toBe(MALE_1995);
  });

  it('rejects a birth date that is not a date', () => {
    expect(() =>
      validateVietnamIdentificationId(MALE_1995, { dob: 'hôm qua' }),
    ).toThrow();
  });
});
