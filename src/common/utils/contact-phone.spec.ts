import { isContactPhone } from './contact-phone';

describe('isContactPhone', () => {
  it.each([
    '0901234567',
    '090 123 4567',
    '090.123.4567',
    '(028) 3822 1234',
    '028-3822-1234',
    '+84901234567',
    '19001234',
    '38221234',
  ])('accepts %s', (value) => {
    expect(isContactPhone(value)).toBe(true);
  });

  it.each([
    '123',
    '1234567',
    'abc',
    '0901234abc',
    '090123456789012345',
    '+',
    '090+1234567',
    '',
    '   ',
  ])('rejects %j', (value) => {
    expect(isContactPhone(value)).toBe(false);
  });

  it('rejects values that are not strings', () => {
    expect(isContactPhone(901234567)).toBe(false);
    expect(isContactPhone(undefined)).toBe(false);
    expect(isContactPhone(null)).toBe(false);
  });
});
