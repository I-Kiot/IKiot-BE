/** Chuẩn hoá số tài khoản ngân hàng để so khớp với SePay. */
export function normalizeAccountNumber(
  value: string | null | undefined,
): string {
  return (value ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();
}
