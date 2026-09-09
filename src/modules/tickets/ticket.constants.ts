/** Ported from the Ticket model's enums. `RESOLVED` is carried over even though no route ever set it - the value exists in production data and the admin UI filters on it, so dropping it would be a schema change. */
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

/** What `POST /tickets` stamps when the client sends no `priority`. */
export const DEFAULT_TICKET_PRIORITY = TicketPriority.MEDIUM;
