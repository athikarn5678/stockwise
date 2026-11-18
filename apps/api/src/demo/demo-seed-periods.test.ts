import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";

import { localDateToUtcBoundary } from "../modules/analytics/analytics-period.ts";
import { demoWindowShape } from "./demo-30d-plan.ts";
import { seededReportPeriods } from "./demo-seed-periods.ts";

const TIMEZONE = "Asia/Bangkok";

/** The same window the seed plan uses: first day three full months back, exclusive run day. */
function windowFor(referenceDate: string) {
  return {
    end: referenceDate,
    start: Temporal.PlainDate.from(referenceDate)
      .with({ day: 1 })
      .subtract({ months: 3 })
      .toString(),
  };
}

function periodsFor(referenceDate: string) {
  const window = windowFor(referenceDate);
  return {
    window,
    periods: seededReportPeriods({
      from: window.start,
      reportingTimezone: TIMEZONE,
      to: window.end,
    }),
  };
}

describe("seeded stored report periods", () => {
  it("returns every fully contained week and month for the 2026-11-18 window", () => {
    expect(demoWindowShape("2026-11-18")).toMatchObject({
      adjustments: true,
      branchLimit: 3,
      days: 109,
      productLimit: 12,
    });
    expect(windowFor("2026-11-18")).toEqual({
      end: "2026-11-18",
      start: "2026-08-01",
    });
    const { periods } = periodsFor("2026-11-18");
    const weeks = periods.filter((period) => period.granularity === "week");
    const months = periods.filter((period) => period.granularity === "month");

    expect(weeks).toHaveLength(15);
    expect(months).toHaveLength(3);
    expect(periods).toHaveLength(18);

    expect(weeks[0]).toMatchObject({
      from: "2026-08-03",
      to: "2026-08-10",
    });
    expect(weeks.at(-1)).toMatchObject({
      from: "2026-11-09",
      to: "2026-11-16",
    });
    // The last included week ends on Sunday 2026-11-15.
    expect(weeks.at(-1)!.periodEndExclusive).toEqual(
      localDateToUtcBoundary("2026-11-16", TIMEZONE),
    );
    expect(months.map((period) => period.from)).toEqual([
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(months.map((period) => period.to)).toEqual([
      "2026-09-01",
      "2026-10-01",
      "2026-11-01",
    ]);
    // November 2026 is still incomplete at the run date and must not appear.
    expect(periods.some((period) => period.from.startsWith("2026-11-16"))).toBe(
      false,
    );
    expect(months.some((period) => period.from === "2026-11-01")).toBe(false);

    for (const period of periods) {
      expect(period.periodStartInclusive).toEqual(
        localDateToUtcBoundary(period.from, TIMEZONE),
      );
      expect(period.periodEndExclusive).toEqual(
        localDateToUtcBoundary(period.to, TIMEZONE),
      );
      expect(period.periodStartInclusive.getTime()).toBeLessThan(
        period.periodEndExclusive.getTime(),
      );
    }

    // 18 completed periods times four scopes (organization plus three branches).
    expect(weeks.length * 4 + months.length * 4).toBe(72);
  });

  it("excludes the current week when the run day is a Monday", () => {
    const { periods } = periodsFor("2026-11-16");
    const weeks = periods.filter((period) => period.granularity === "week");
    const months = periods.filter((period) => period.granularity === "month");
    expect(weeks).toHaveLength(15);
    // Monday 2026-11-16 starts the run week, so the last stored week ends there.
    expect(weeks.at(-1)).toMatchObject({
      from: "2026-11-09",
      to: "2026-11-16",
    });
    expect(months.map((period) => period.from)).toEqual([
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
  });

  it("keeps a full month that ends exactly on the exclusive boundary", () => {
    expect(windowFor("2026-12-01")).toEqual({
      end: "2026-12-01",
      start: "2026-09-01",
    });
    const { periods } = periodsFor("2026-12-01");
    const weeks = periods.filter((period) => period.granularity === "week");
    const months = periods.filter((period) => period.granularity === "month");
    expect(weeks).toHaveLength(12);
    expect(weeks[0]).toMatchObject({ from: "2026-09-07", to: "2026-09-14" });
    expect(weeks.at(-1)).toMatchObject({
      from: "2026-11-23",
      to: "2026-11-30",
    });
    // September, October and November are complete; December 1 is the boundary.
    expect(months.map((period) => period.from)).toEqual([
      "2026-09-01",
      "2026-10-01",
      "2026-11-01",
    ]);
    expect(months.at(-1)!.to).toBe("2026-12-01");
  });

  it("counts a leap-year February as one complete month", () => {
    expect(windowFor("2028-03-05")).toEqual({
      end: "2028-03-05",
      start: "2027-12-01",
    });
    const { periods } = periodsFor("2028-03-05");
    const weeks = periods.filter((period) => period.granularity === "week");
    const months = periods.filter((period) => period.granularity === "month");
    expect(weeks).toHaveLength(12);
    expect(weeks[0]).toMatchObject({ from: "2027-12-06", to: "2027-12-13" });
    expect(weeks.at(-1)).toMatchObject({
      from: "2028-02-21",
      to: "2028-02-28",
    });
    expect(months.map((period) => period.from)).toEqual([
      "2027-12-01",
      "2028-01-01",
      "2028-02-01",
    ]);
    const february = months[2]!;
    expect(february.to).toBe("2028-03-01");
    expect(
      (february.periodEndExclusive.getTime() -
        february.periodStartInclusive.getTime()) /
        86_400_000,
    ).toBe(29);
  });

  it("rejects an empty or inverted window", () => {
    expect(() =>
      seededReportPeriods({
        from: "2026-11-18",
        reportingTimezone: TIMEZONE,
        to: "2026-11-18",
      }),
    ).toThrow(/earlier than/);
    expect(() =>
      seededReportPeriods({
        from: "2026-11-18",
        reportingTimezone: TIMEZONE,
        to: "2026-11-01",
      }),
    ).toThrow(/earlier than/);
  });
});
