/** A Vietnamese phone number in E.164, used for keying (the OTP store) rather than storage - `User.phoneNumber` keeps whatever the user typed. */
export function normalizePhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const cleaned = String(phone)
    .trim()
    .replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('84')) return `+${cleaned}`;
  if (cleaned.startsWith('0')) return `+84${cleaned.slice(1)}`;
  return `+${cleaned}`;
}
