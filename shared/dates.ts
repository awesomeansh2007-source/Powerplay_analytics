/**
 * IST-calendar date helpers. Every date in the app is a `YYYY-MM-DD` string on the
 * Asia/Kolkata calendar; arithmetic is done on UTC-midnight epochs of that string so it
 * never drifts with the host time zone.
 */
import type { ISODate } from './types.ts';

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

export function isISODate(s: unknown): s is ISODate {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

/** Days since 1970-01-01 for an ISO date. */
export function toDayNumber(d: ISODate): number {
  return Math.round(Date.parse(d + 'T00:00:00Z') / DAY_MS);
}

export function fromDayNumber(n: number): ISODate {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromDayNumber(toDayNumber(d) + n);
}

/** b − a in calendar days. */
export function diffDays(a: ISODate, b: ISODate): number {
  return toDayNumber(b) - toDayNumber(a);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(d: ISODate): number {
  return new Date(d + 'T00:00:00Z').getUTCDay();
}

/** Today on the IST calendar. */
export function todayIST(now: Date = new Date()): ISODate {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** IST calendar date of an instant (ISO datetime string in UTC, or ClickHouse 'YYYY-MM-DD hh:mm:ss' UTC). */
export function istDateOf(instant: string): ISODate | null {
  if (!instant) return null;
  const iso = instant.includes('T') ? instant : instant.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  const t = Date.parse(withZone);
  if (Number.isNaN(t)) return null;
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Inclusive list of dates from a to b. */
export function dateRange(a: ISODate, b: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let n = toDayNumber(a), end = toDayNumber(b); n <= end; n++) out.push(fromDayNumber(n));
  return out;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}

export function clampDate(d: ISODate, lo: ISODate, hi: ISODate): ISODate {
  return d < lo ? lo : d > hi ? hi : d;
}

/** Sunday that starts the week containing d (Powerplay weeks run Sunday–Saturday). */
export function weekStart(d: ISODate): ISODate {
  return addDays(d, -weekday(d));
}

/**
 * Working days strictly after `from` up to and including `to`.
 * 0 when `to` ≤ `from`. Used for "working days since last update".
 */
export function workingDaysBetween(from: ISODate, to: ISODate, workingDays: number[]): number {
  const set = new Set(workingDays);
  let n = 0;
  for (let d = toDayNumber(from) + 1, end = toDayNumber(to); d <= end; d++) {
    if (set.has(((d % 7) + 4 + 7) % 7)) n++; // 1970-01-01 was a Thursday (4)
  }
  return n;
}
