/** Đọc body thô của handler an toàn, sai dạng thì trả null / [] chứ không ném. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function readChild(x: unknown, key: string): unknown {
  return isRecord(x) ? x[key] : undefined;
}

/** `{ id, code? }` của một bản ghi; yêu cầu `id` là chuỗi. */
export function readRef(
  x: unknown,
): { id: string; code: string | null } | null {
  if (!isRecord(x) || typeof x.id !== 'string') return null;
  return { id: x.id, code: typeof x.code === 'string' ? x.code : null };
}

/** `readRef` của một khoá con (`body.order`). */
export function readRefOf(
  x: unknown,
  key: string,
): { id: string; code: string | null } | null {
  return readRef(readChild(x, key));
}

export function readString(x: unknown, key: string): string | null {
  const value = readChild(x, key);
  return typeof value === 'string' ? value : null;
}

/** Gom các chuỗi id theo đường dẫn khoá trong body. */
export function readIdList(x: unknown, path: readonly string[]): string[] {
  let level: unknown[] = [x];
  for (const key of path) {
    level = level.flatMap((node) => {
      const next = readChild(node, key);
      return Array.isArray(next) ? (next as unknown[]) : [next];
    });
  }
  return level.filter((v): v is string => typeof v === 'string');
}

/** `"đơn DH0012"`, hoặc `"một đơn"` khi chưa có mã. Chỉ là bộ định dạng, không phải nội dung nghiệp vụ. */
export function named(noun: string, code: string | null): string {
  return code ? `${noun} ${code}` : `một ${noun}`;
}

/** Viết hoa chữ đầu, cho câu mở đầu bằng chủ thể (`"Đơn DH0012 vừa được…"`). */
export function upperFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase('vi-VN') + text.slice(1);
}
