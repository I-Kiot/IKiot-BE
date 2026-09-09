import { randomBytes } from 'node:crypto';

// One generator for every reference code, prefixed from REFERENCE_PREFIX; 5 random bytes keeps collisions negligible against a global unique index, so don't lower byteLength without reason.
export function generateReference(prefix: string, byteLength = 5): string {
  return prefix + randomBytes(byteLength).toString('hex').toUpperCase();
}

/** Anchored regex to find/filter references of a given flow, e.g. referenceMatcher('ORD') -> /^ORD/i. */
export function referenceMatcher(prefix: string): RegExp {
  return new RegExp('^' + prefix, 'i');
}

// Values are PERSISTED on historical rows - never rename an existing prefix, only add.
export const REFERENCE_PREFIX = {
  ORDER: 'ORD',
  SUPPLIER: 'SUP',
  PAYROLL: 'PAYR',
  SUBSCRIPTION: 'IKMS', // tenant pays iKiot for a plan (company bank - not tenant CashFlow)
  TICKET: 'TK', // support thread; shown to both the shop and the operator
} as const;

export const CASHFLOW_PREFIXES = [
  REFERENCE_PREFIX.ORDER,
  REFERENCE_PREFIX.SUPPLIER,
  REFERENCE_PREFIX.PAYROLL,
];
