import { useEffect, useState } from "react";

/** The value once it has stopped changing for `delay` ms: lets a live region speak after typing pauses, not per keystroke. */
export function useSettled<T>(value: T, delay = 500): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** False on the server and on the first client render, true once the page is interactive. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
