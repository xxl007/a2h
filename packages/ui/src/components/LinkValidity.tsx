import { useEffect, useState } from "react";
import { copy } from "../screens/copy.js";
import { HOUR_MS, linkEndsSoon } from "./datetime.js";
import { fillNodes } from "./fillNodes.js";
import { LocalTime } from "./LocalTime.js";

export interface LinkValidityProps {
  /** ISO with offset: when the approval link stops working. */
  until: string;
  /**
   * ISO with offset: the clock at render, the server's. Decides the first paint, so the
   * server and the hydrating browser agree and a JavaScript-off reader gets the server's answer.
   * Absent: the line is left out until the browser's clock has been read.
   */
  now?: string;
  /** Fixed zone for stories and tests; with it the clock is fixed too and the browser never takes over. */
  timeZone?: string;
}

/**
 * "This link works until {time}." after the decision note, shown only when less than an hour
 * of the link is left (m2-approval-page design.md, decision bar; owner decision 2026-11-05).
 * After hydration the browser's clock takes over, as LocalTime's zone does: a page left open
 * gains the line when the hour begins, and the polite live region, present from the first
 * paint, announces it once.
 */
export function LinkValidity({ until, now, timeZone }: LinkValidityProps) {
  const [shown, setShown] = useState(now !== undefined && linkEndsSoon(until, now));
  useEffect(() => {
    if (timeZone !== undefined) return;
    const wait = Date.parse(until) - HOUR_MS - Date.now();
    if (wait <= 0) {
      setShown(true);
      return;
    }
    const timer = setTimeout(() => setShown(true), wait);
    return () => clearTimeout(timer);
  }, [until, timeZone]);
  return (
    <span aria-live="polite">
      {shown && (
        <>
          {" "}
          {fillNodes(copy.approval.linkValidity, { time: <LocalTime iso={until} {...(timeZone !== undefined ? { timeZone } : {})} /> })}
        </>
      )}
    </span>
  );
}
