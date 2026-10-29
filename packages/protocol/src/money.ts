// Money helpers (ADR 0002 §3, §4, §12). Amounts are integers in minor units.
// The fee rate f and the clearing share s are arguments: no value is assumed
// here. Rates are read to the millionth (a configured 0.2 is exactly 20%);
// arithmetic is exact (BigInt) and each result is rounded half up once.

const PPM = 1_000_000n;

function amount(name: string, value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer in minor units`);
  }
  return BigInt(value);
}

function rate(name: string, value: number, { allowOne }: { allowOne: boolean }): bigint {
  const ok = Number.isFinite(value) && value >= 0 && (allowOne ? value <= 1 : value < 1);
  if (!ok) throw new RangeError(`${name} must be in [0, 1${allowOne ? "]" : ")"}`);
  return BigInt(Math.round(value * 1_000_000));
}

/** round(a / b), half up, for a ≥ 0 and b > 0. */
function divHalfUp(a: bigint, b: bigint): bigint {
  return (2n * a + b) / (2n * b);
}

function toNumber(name: string, value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${name} exceeds the safe integer range`);
  return n;
}

/** Gross (what the principal sees) from net (what the participant receives): net / (1 − f), half up. */
export function gross(netMinor: number, f: number): number {
  const n = amount("net", netMinor);
  const fp = rate("fee rate", f, { allowOne: false });
  return toNumber("gross", divHalfUp(n * PPM, PPM - fp));
}

/** Platform fee on a gross (cleared) amount: f × gross, half up (ADR 0002: fee = round(f × capture)). */
export function fee(grossMinor: number, f: number): number {
  const g = amount("gross", grossMinor);
  const fp = rate("fee rate", f, { allowOne: false });
  return toNumber("fee", divHalfUp(g * fp, PPM));
}

/** Net (what the participant receives) from gross: gross − fee(gross, f). net(gross(n, f), f) = n for every f in [0, 1). */
export function net(grossMinor: number, f: number): number {
  return grossMinor - fee(grossMinor, f);
}

/** Clearing price between reserve and bid (both gross): reserve + s × (bid − reserve), half up; reserve ≤ result ≤ bid. */
export function clear(reserveMinor: number, bidMinor: number, s: number): number {
  const r = amount("reserve", reserveMinor);
  const b = amount("bid", bidMinor);
  const sp = rate("share", s, { allowOne: true });
  if (b < r) throw new RangeError("bid must not be below the reserve");
  return toNumber("clearing", r + divHalfUp((b - r) * sp, PPM));
}
