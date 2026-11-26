/** Chuẩn hoá SĐT Việt Nam về E.164 để làm khoá. */
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
