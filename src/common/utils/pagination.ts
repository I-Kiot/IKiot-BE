// The list envelope every ported list endpoint returns - the `{ data, pagination }` shape the frontend's tables already read.
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

/** `skip` for a 1-based page number. */
export function skipFor(page: number, limit: number): number {
  return (page - 1) * limit;
}
