/** Port từ enum của model Ticket. `RESOLVED` giữ lại dù không route nào set: giá trị này có trong dữ liệu production và admin UI lọc theo nó, bỏ đi là đổi schema. */
export const TicketStatus = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
} as const;

export const TICKET_STATUSES = Object.values(TicketStatus);

export const TicketPriority = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  URGENT: 'URGENT',
} as const;

export const TICKET_PRIORITIES = Object.values(TicketPriority);

export const DEFAULT_TICKET_PRIORITY = TicketPriority.MEDIUM;
