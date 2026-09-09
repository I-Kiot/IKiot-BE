/** What the platform operators' inbox is made of: a row is a system notification when `tenantId` and `recipientId` are both null, and this type whitelist is a second, narrower gate so a new `notifySystem` type never silently changes what an operator sees. */
export const SystemNotificationType = {
  TRANSACTION: 'SYSTEM_TRANSACTION',
  TENANT_CREATED: 'SYSTEM_TENANT_CREATED',
  TICKET_CREATED: 'SYSTEM_TICKET_CREATED',
  TENANT_BANK_UPDATED: 'SYSTEM_TENANT_BANK_UPDATED',
} as const;

export const SYSTEM_NOTIFICATION_TYPES: string[] = Object.values(
  SystemNotificationType,
);

/** Announcements are not system events and never appear in that feed - an operator wrote this one, and the row exists to record that it was sent. */
export const ANNOUNCEMENT_TYPE = 'ANNOUNCEMENT';

/** Who an announcement goes to. `SELECTION` is the only one that reads `targetTenants`. */
export const AnnouncementTarget = {
  ALL: 'ALL',
  SELECTION: 'SELECTION',
} as const;

export const ANNOUNCEMENT_TARGETS: string[] = Object.values(AnnouncementTarget);

/** The four categories the admin UI offers - documentation, not a validation whitelist, since the value is free text printed straight into the email subject line. */
export const KNOWN_ANNOUNCEMENT_CATEGORIES = [
  'Maintenance',
  'New feature',
  'Promotion',
  'Security',
];
