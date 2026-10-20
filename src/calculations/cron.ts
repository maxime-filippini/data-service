/**
 * A standard 5-field cron expression in UTC: minute, hour, day of month,
 * month, day of week. Each field is `*`, a value, a range `a-b`, a step
 * (`*\/n`, `a-b/n` or `a/n`), or a comma-separated list of those. Months and
 * days of week also take names (`JAN`, `MON`); Sunday is 0 or 7.
 */
export interface CronSchedule {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 is Sunday. */
  readonly daysOfWeek: ReadonlySet<number>;
  /**
   * Whether the day-of-month and day-of-week fields are both restricted (not
   * `*`). Then a day matches if either matches, as in standard cron.
   */
  readonly eitherDay: boolean;
}

interface Field {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

const MINUTE: Field = { name: "minute", min: 0, max: 59 };
const HOUR: Field = { name: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: Field = { name: "day of month", min: 1, max: 31 };
const MONTH: Field = {
  name: "month",
  min: 1,
  max: 12,
  names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
};
// 7 is accepted as Sunday and folded into 0 below.
const DAY_OF_WEEK: Field = { name: "day of week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] };

class CronSyntaxError extends Error {}

const valueOf = (text: string, field: Field) => {
  const index = field.names?.indexOf(text.toUpperCase()) ?? -1;
  if (index >= 0) return index + field.min;
  if (!/^\d+$/u.test(text)) throw new CronSyntaxError(`Invalid ${field.name} "${text}"`);
  const value = Number(text);
  if (value < field.min || value > field.max) {
    throw new CronSyntaxError(`The ${field.name} must be between ${field.min} and ${field.max}, not ${value}`);
  }
  return value;
};

const parseField = (text: string, field: Field) => {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", step, ...rest] = part.split("/");
    if (rest.length > 0 || range === "") throw new CronSyntaxError(`Invalid ${field.name} "${part}"`);

    let start: number;
    let end: number;
    if (range === "*") {
      [start, end] = [field.min, field.max];
    } else if (range.includes("-")) {
      const [from = "", to = "", ...more] = range.split("-");
      if (more.length > 0) throw new CronSyntaxError(`Invalid ${field.name} "${part}"`);
      [start, end] = [valueOf(from, field), valueOf(to, field)];
      if (start > end) throw new CronSyntaxError(`The ${field.name} range "${range}" goes backwards`);
    } else {
      start = valueOf(range, field);
      // `a/n` means from a to the end, every n.
      end = step === undefined ? start : field.max;
    }

    let every = 1;
    if (step !== undefined) {
      if (!/^\d+$/u.test(step) || Number(step) === 0) throw new CronSyntaxError(`Invalid ${field.name} step "${step}"`);
      every = Number(step);
    }
    for (let value = start; value <= end; value += every) values.add(value);
  }
  return values;
};

/** Parses a cron expression, or returns why it's invalid. */
export const parseCron = (expression: string): CronSchedule | { readonly error: string } => {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return { error: `A cron expression has 5 fields (minute hour day-of-month month day-of-week), not ${fields.length}` };
  }
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  try {
    const daysOfWeek = parseField(dayOfWeek, DAY_OF_WEEK);
    if (daysOfWeek.delete(7)) daysOfWeek.add(0);
    return {
      minutes: parseField(minute, MINUTE),
      hours: parseField(hour, HOUR),
      daysOfMonth: parseField(dayOfMonth, DAY_OF_MONTH),
      months: parseField(month, MONTH),
      daysOfWeek,
      eitherDay: !dayOfMonth.startsWith("*") && !dayOfWeek.startsWith("*"),
    };
  } catch (error) {
    if (error instanceof CronSyntaxError) return { error: error.message };
    throw error;
  }
};

export const isCronError = (parsed: ReturnType<typeof parseCron>): parsed is { readonly error: string } =>
  "error" in parsed;
