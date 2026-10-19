const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "Oct 19, 2026, 2:00 AM" */
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

/** "3 hours ago", "just now" */
export const formatAgo = (iso: string, now = Date.now()) => {
  const seconds = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
};

/** "850 ms", "12 s", "3 min 5 s" */
export const formatDuration = (fromIso: string, toIso: string) => {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

export const formatCount = (value: number) => value.toLocaleString();

/** "2016-01-04 → 2026-10-17" */
export const formatRange = (from: string | null, to: string | null) =>
  from === null && to === null ? "—" : `${from ?? "?"} → ${to ?? "?"}`;
