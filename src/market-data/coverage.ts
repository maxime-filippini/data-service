export interface DateRange {
  readonly from: string;
  readonly to: string;
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

const toEpochDay = (date: string) =>
  Date.parse(`${date}T00:00:00.000Z`) / DAY_IN_MILLISECONDS;

const fromEpochDay = (day: number) =>
  new Date(day * DAY_IN_MILLISECONDS).toISOString().slice(0, 10);

const dayBefore = (date: string) => fromEpochDay(toEpochDay(date) - 1);
const dayAfter = (date: string) => fromEpochDay(toEpochDay(date) + 1);

/** Merge overlapping or adjacent coverage ranges. */
export const mergeDateRanges = (
  ranges: readonly DateRange[],
): readonly DateRange[] => {
  const sorted = [...ranges].sort((left, right) =>
    left.from.localeCompare(right.from),
  );
  const merged: DateRange[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);

    if (previous === undefined || range.from > dayAfter(previous.to)) {
      merged.push(range);
      continue;
    }

    merged[merged.length - 1] = {
      from: previous.from,
      to: range.to > previous.to ? range.to : previous.to,
    };
  }

  return merged;
};

/** Return the portions of `requested` that are not already covered. */
export const subtractDateRanges = (
  requested: DateRange,
  covered: readonly DateRange[],
): readonly DateRange[] => {
  const missing: DateRange[] = [];
  let cursor = requested.from;

  for (const range of mergeDateRanges(covered)) {
    if (range.to < cursor) {
      continue;
    }

    if (range.from > requested.to) {
      break;
    }

    if (range.from > cursor) {
      missing.push({
        from: cursor,
        to: dayBefore(range.from),
      });
    }

    if (range.to >= requested.to) {
      return missing;
    }

    cursor = dayAfter(range.to);
  }

  if (cursor <= requested.to) {
    missing.push({ from: cursor, to: requested.to });
  }

  return missing;
};
