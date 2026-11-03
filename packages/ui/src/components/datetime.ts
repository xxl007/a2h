/**
 * Date-times shown to principals (m2-approval-page design.md, Screens A0):
 * "12:20 on 1 Nov 2026 (UTC+01:00)". 24-hour clock, day, abbreviated month,
 * year, then the offset of the zone the time is shown in. "UTC" for offset 0.
 * Never an ISO string, never a zone name the page cannot know.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatDateTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new RangeError(`not a date-time: ${iso}`);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const raw = get("timeZoneName").replace(/^GMT/, "UTC");
  const offset = raw === "" || raw === "UTC+00:00" || raw === "UTC-00:00" ? "UTC" : raw;
  return `${get("hour")}:${get("minute")} on ${Number(get("day"))} ${MONTHS[Number(get("month")) - 1]} ${get("year")} (${offset})`;
}

/** The browser's zone, or UTC where it cannot be read (server render, old engines). */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
