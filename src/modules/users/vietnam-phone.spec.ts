import { validateVietnamPhoneNumber } from './vietnam-phone';

// The phone number is the login handle and the OTP destination, so "accepted but can never receive an SMS" is an account nobody can get into.
describe('validateVietnamPhoneNumber', () => {
  it.each([
    ['Viettel', '0321234567'],
    ['Vietnamobile', '0521234567'],
    ['Mobifone', '0701234567'],
    ['Vinaphone', '0811234567'],
    ['dải 09x cũ', '0901234567'],
  ])('accepts a %s number', (_carrier, value) => {
    expect(validateVietnamPhoneNumber(value)).toBe(value);
  });

  it('trims surrounding whitespace', () => {
    expect(validateVietnamPhoneNumber(' 0901234567 ')).toBe('0901234567');
  });

  it.each([
    ['rỗng', '   '],
    ['có chữ', '090123456a'],
    ['thiếu chữ số', '090123456'],
    ['thừa chữ số', '09012345678'],
    ['đầu số không tồn tại', '0311234567'],
    ['số cố định', '0241234567'],
  ])('rejects a number that is %s', (_label, value) => {
    expect(() => validateVietnamPhoneNumber(value)).toThrow();
  });

  it.each([
    ['VoIP 065', '0651234567'],
    ['vệ tinh 067', '0671234567'],
    ['mạng dùng riêng 069', '0692345678'],
    ['Cục Bưu điện TW 080', '0801234567'],
  ])('rejects the reserved range %s', (_label, value) => {
    expect(() => validateVietnamPhoneNumber(value)).toThrow();
  });

  it.each(['111', '112', '113', '114', '115'])(
    'rejects the emergency line %s with a reason, not a length complaint',
    (value) => {
      expect(() => validateVietnamPhoneNumber(value)).toThrow(
        /emergency number/,
      );
    },
  );
});
