/** One spelling, so what a shop typed, what SePay lists and what a webhook sends compare equal. Letters stay: a virtual account may carry them. */
export function normalizeAccountNumber(
  value: string | null | undefined,
): string {
  return (value ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();
}
