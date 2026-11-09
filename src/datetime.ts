/**
 * Shared UTC date arithmetic for scheduling, data cutoffs and browser inputs.
 * These helpers use valid Date values, return new values without mutation,
 * and have no Effect/Cloudflare dependencies. Display formatting stays in the app.
 */

/** Milliseconds per minute, for expressing feature-owned timeout policies. */
export const MINUTE_MS = 60 * 1000;

/** Milliseconds per hour; UTC arithmetic has no daylight-saving adjustment. */
export const HOUR_MS = 60 * MINUTE_MS;

/** Milliseconds per UTC day. This is not a local-time calendar-day duration. */
export const DAY_MS = 24 * HOUR_MS;

/** UTC calendar date in YYYY-MM-DD form, for persisted cutoffs and date inputs. */
export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Shift by a whole number of UTC days, preserving the UTC time of day. */
export const addUtcDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * DAY_MS);

/** Previous UTC calendar date, including weekends and holidays. */
export const previousDay = (date: Date): string => utcDay(addUtcDays(date, -1));

/** Midnight at the beginning of the supplied instant's UTC calendar day. */
export const startOfUtcDay = (date: Date): Date =>
  new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS);

/** Whole UTC hour (0–23) on the supplied instant's UTC day, with minutes cleared. */
export const atUtcHour = (date: Date, hour: number): Date =>
  new Date(startOfUtcDay(date).getTime() + hour * HOUR_MS);

/** Next whole UTC hour, strictly after the instant even if already on the hour. */
export const nextUtcHour = (date: Date): Date =>
  new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
