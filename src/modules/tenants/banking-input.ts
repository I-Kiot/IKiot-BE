/** Ba ô ngân hàng ở `PUT /tenant/me`, có thể bỏ trống. */
export interface PartialBankingInput {
  accountNumber?: string | null;
  bankName?: string | null;
  accountName?: string | null;
}

export interface CompleteBankingInput {
  accountNumber: string;
  bankName: string;
  accountName: string;
}

export type BankingInputField = keyof CompleteBankingInput;

export type BankingInputResult =
  | { kind: 'EMPTY' }
  | { kind: 'COMPLETE'; banking: CompleteBankingInput }
  | { kind: 'INCOMPLETE'; missing: BankingInputField[] };

const FIELDS: BankingInputField[] = [
  'accountNumber',
  'bankName',
  'accountName',
];

/** Phân loại ba ô ngân hàng: trống cả ba, đủ cả ba, hoặc thiếu. */
export function classifyBankingInput(
  input: PartialBankingInput | undefined,
): BankingInputResult {
  if (!input) return { kind: 'EMPTY' };
  const trimmed = {
    accountNumber: (input.accountNumber ?? '').trim(),
    bankName: (input.bankName ?? '').trim(),
    accountName: (input.accountName ?? '').trim(),
  };
  const missing = FIELDS.filter((field) => !trimmed[field]);
  if (missing.length === FIELDS.length) return { kind: 'EMPTY' };
  if (missing.length > 0) return { kind: 'INCOMPLETE', missing };
  return { kind: 'COMPLETE', banking: trimmed };
}
