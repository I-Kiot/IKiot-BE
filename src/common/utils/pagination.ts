// Envelope danh sách mà mọi endpoint list đã port đều trả về - dạng `{ data, pagination }` mà bảng của frontend đã đọc.
export interface Paginated<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export function paginate<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): Paginated<T> {
  return {
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/** `skip` cho số trang đánh từ 1. */
export function skipFor(page: number, limit: number): number {
  return (page - 1) * limit;
}
