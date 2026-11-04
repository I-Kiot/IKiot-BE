/** Một cách viết duy nhất, để thứ shop gõ, thứ SePay liệt kê và thứ webhook gửi về so khớp được với nhau. Giữ lại chữ cái vì tài khoản ảo có thể có chữ. */
export function normalizeAccountNumber(
  value: string | null | undefined,
): string {
  return (value ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();
}
