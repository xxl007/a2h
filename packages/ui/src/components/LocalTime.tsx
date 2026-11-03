import { useEffect, useState } from "react";
import { formatDateTime, viewerTimeZone } from "./datetime.js";

export interface LocalTimeProps {
  /** ISO 8601 date-time with offset, as stored. */
  iso: string;
  /** Fixed zone, for stories and tests only. Pages leave it out. */
  timeZone?: string;
}

/**
 * A date-time in the viewer's own zone with its offset (spec approval-page "Time zone").
 * The server renders it in UTC; after hydration the browser replaces it with its own zone,
 * so the first paint never mismatches and JavaScript-off readers still get a correct time.
 */
export function LocalTime({ iso, timeZone }: LocalTimeProps) {
  const [zone, setZone] = useState(timeZone ?? "UTC");
  useEffect(() => {
    if (timeZone === undefined) setZone(viewerTimeZone());
  }, [timeZone]);
  return <time dateTime={iso}>{formatDateTime(iso, zone)}</time>;
}
