/** Timezone-aware bucketing helpers. All analytics accept an IANA timezone so a
 * trader's "day" matches their session, not the server's clock. */

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const partFormatters = new Map<string, Intl.DateTimeFormat>();

const dateFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
};

const partFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      hour12: false,
    });
    partFormatters.set(timeZone, formatter);
  }
  return formatter;
};

/** "YYYY-MM-DD" in the given timezone. */
export const dayKeyOf = (iso: string, timeZone = "UTC"): string =>
  dateFormatter(timeZone).format(new Date(iso));

/** "YYYY-MM" in the given timezone. */
export const monthKeyOf = (iso: string, timeZone = "UTC"): string =>
  dayKeyOf(iso, timeZone).slice(0, 7);

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const weekdayOf = (iso: string, timeZone = "UTC"): Weekday => {
  const parts = partFormatter(timeZone).formatToParts(new Date(iso));
  return (parts.find((p) => p.type === "weekday")?.value ?? "Sun") as Weekday;
};

/** Hour of day 0-23 in the given timezone. */
export const hourOf = (iso: string, timeZone = "UTC"): number => {
  const parts = partFormatter(timeZone).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return hour === 24 ? 0 : hour;
};

export const TRADING_SESSIONS = [
  "Asian",
  "London",
  "London/NY Overlap",
  "New York",
  "Off-hours",
] as const;
export type TradingSession = (typeof TRADING_SESSIONS)[number];

/**
 * Standard trading session based on trade open time in UTC:
 * - Asian: 00:00 - 08:00 UTC (Tokyo/Sydney)
 * - London: 08:00 - 13:00 UTC (European morning)
 * - London/NY Overlap: 13:00 - 16:00 UTC (Peak global liquidity & volatility)
 * - New York: 16:00 - 21:00 UTC (US afternoon)
 * - Off-hours: 21:00 - 24:00 UTC
 */
export const sessionOf = (iso: string): TradingSession => {
  const utcHour = hourOf(iso, "UTC");
  if (utcHour >= 0 && utcHour < 8) return "Asian";
  if (utcHour >= 8 && utcHour < 13) return "London";
  if (utcHour >= 13 && utcHour < 16) return "London/NY Overlap";
  if (utcHour >= 16 && utcHour < 21) return "New York";
  return "Off-hours";
};
