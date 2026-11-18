import { Temporal } from "@js-temporal/polyfill";

import {
  AnalyticsPeriodError,
  createAnalyticsPeriodContext,
  localDateToUtcBoundary,
  validateIanaTimeZone,
} from "../modules/analytics/analytics-period.ts";

/** Stored report cadences the seed step produces: completed weeks and months. */
export type SeededReportGranularity = "week" | "month";

export interface SeededReportPeriod {
  /** Period start local date, inclusive: a Monday or the first day of a month. */
  from: string;
  granularity: SeededReportGranularity;
  periodEndExclusive: Date;
  periodStartInclusive: Date;
  /** Period end local date, exclusive: the next period start. */
  to: string;
}

function parseLocalDate(value: string): Temporal.PlainDate {
  try {
    return Temporal.PlainDate.from(value, { overflow: "reject" });
  } catch {
    throw new AnalyticsPeriodError(
      "INVALID_LOCAL_DATE",
      "Seeded report boundaries must be valid ISO calendar dates.",
    );
  }
}

function firstAlignedDate(
  from: Temporal.PlainDate,
  granularity: SeededReportGranularity,
): Temporal.PlainDate {
  if (granularity === "month")
    return Temporal.PlainDate.compare(from.with({ day: 1 }), from) === 0
      ? from
      : from.with({ day: 1 }).add({ months: 1 });
  return from.dayOfWeek === 1 ? from : from.add({ days: 8 - from.dayOfWeek });
}

function nextDate(
  date: Temporal.PlainDate,
  granularity: SeededReportGranularity,
): Temporal.PlainDate {
  return granularity === "month"
    ? date.add({ months: 1 })
    : date.add({ days: 7 });
}

/**
 * Every Monday-Sunday week and every calendar month that lies FULLY inside the
 * seed window `[from, to)`, in the organization reporting timezone. The current
 * incomplete week or month is never included, and `to` is exclusive, so the run
 * day itself never contributes a partial period.
 */
export function seededReportPeriods(input: {
  from: string;
  reportingTimezone: string;
  to: string;
}): readonly SeededReportPeriod[] {
  const from = parseLocalDate(input.from);
  const to = parseLocalDate(input.to);
  if (Temporal.PlainDate.compare(from, to) >= 0)
    throw new AnalyticsPeriodError(
      "INVALID_RANGE",
      "Seeded report from must be earlier than to.",
    );
  const reportingTimezone = validateIanaTimeZone(input.reportingTimezone);
  const sourceCutoff = localDateToUtcBoundary(input.to, reportingTimezone);

  return (["week", "month"] as const).flatMap((granularity) => {
    const periods: SeededReportPeriod[] = [];
    for (
      let start = firstAlignedDate(from, granularity);
      Temporal.PlainDate.compare(nextDate(start, granularity), to) <= 0;
      start = nextDate(start, granularity)
    ) {
      const end = nextDate(start, granularity);
      const period = createAnalyticsPeriodContext({
        from: start.toString(),
        granularity,
        reportingTimezone,
        sourceCutoff,
        to: end.toString(),
      });
      periods.push(
        Object.freeze({
          from: period.from,
          granularity,
          periodEndExclusive: period.periodEndExclusive,
          periodStartInclusive: period.periodStartInclusive,
          to: period.to,
        }),
      );
    }
    return periods;
  });
}
