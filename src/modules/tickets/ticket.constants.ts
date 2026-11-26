/** Trạng thái ticket. */
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
