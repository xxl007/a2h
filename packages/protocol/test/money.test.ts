// Spec protocol/schemas: "Gross from net rounds once, half up", "Bounds hold
// for any share"; ADR 0002 §3, §4, §12 (f and s are arguments, never constants).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { clear, fee, gross, net } from "../src/index.ts";
import { PROPERTY_RUNS, prng } from "./prng.ts";

describe("Scenario: Gross from net rounds once, half up", () => {
  test("net reserve 2500 at a 20% fee is 3125 gross, and 3125 back is 2500", () => {
    assert.equal(gross(2500, 0.2), 3125);
    assert.equal(net(3125, 0.2), 2500);
  });
  test("half-up at the minor unit, once", () => {
    // 1000 / (1 - 0.3) = 1428.571… → 1429; 2 / (1 - 0.2) = 2.5 → 3 (half up)
    assert.equal(gross(1000, 0.3), 1429);
    assert.equal(gross(2, 0.2), 3);
    assert.equal(net(3, 0.2), 2);
    // fee = round(f × gross) half up: 0.5 × 3 = 1.5 → 2; net = 3 − 2 = 1
    assert.equal(fee(3, 0.5), 2);
    assert.equal(net(3, 0.5), 1);
  });
  test("a configured rate is read as the decimal it was written as, to the millionth", () => {
    // 0.3 as a binary double is 0.29999…; 5 × 0.3 = 1.5 must still round up to 2.
    assert.equal(fee(5, 0.3), 2);
    assert.equal(fee(10, 0.15), 2); // 1.5 → 2
  });
  test("a zero fee changes nothing", () => {
    assert.equal(gross(2500, 0), 2500);
    assert.equal(net(2500, 0), 2500);
  });
  test("property: net(gross(n, f), f) = n and fee + net = gross, for any f in [0, 1)", () => {
    const r = prng(20261021);
    for (let i = 0; i < PROPERTY_RUNS; i++) {
      const n = Math.floor(r() * 1_000_000);
      const f = Math.round(r() * 0.99 * 1e6) / 1e6;
      const g = gross(n, f);
      assert.ok(Number.isSafeInteger(g) && g >= n, `gross(${n}, ${f}) = ${g}`);
      assert.equal(net(g, f), n, `round trip n=${n} f=${f} g=${g}`);
      assert.equal(fee(g, f) + net(g, f), g);
    }
  });
});

describe("Scenario: Bounds hold for any share", () => {
  test("reserve 2500, bid 3000: 2500 at share 0, 3000 at share 1, 2750 at 0.5", () => {
    assert.equal(clear(2500, 3000, 0), 2500);
    assert.equal(clear(2500, 3000, 1), 3000);
    assert.equal(clear(2500, 3000, 0.5), 2750);
  });
  test("property: reserve ≤ clear(reserve, bid, s) ≤ bid for every share in [0, 1]", () => {
    const r = prng(42);
    for (let i = 0; i < PROPERTY_RUNS; i++) {
      const s = i === 0 ? 0 : i === 1 ? 1 : r();
      const c = clear(2500, 3000, s);
      assert.ok(Number.isSafeInteger(c) && c >= 2500 && c <= 3000, `s=${s} → ${c}`);
      const reserve = Math.floor(r() * 100_000);
      const bid = reserve + Math.floor(r() * 100_000);
      const c2 = clear(reserve, bid, s);
      assert.ok(Number.isSafeInteger(c2) && c2 >= reserve && c2 <= bid, `reserve=${reserve} bid=${bid} s=${s} → ${c2}`);
    }
  });
  test("property: clearing is monotonic in the share", () => {
    const r = prng(7);
    for (let i = 0; i < PROPERTY_RUNS; i++) {
      const [a, b] = [r(), r()].sort((x, y) => x - y) as [number, number];
      assert.ok(clear(2500, 3000, a) <= clear(2500, 3000, b));
    }
  });
});

describe("Inputs are refused rather than coerced", () => {
  test("fractional, negative or unsafe amounts throw", () => {
    for (const bad of [30.5, -1, Number.NaN, 2 ** 53]) {
      assert.throws(() => gross(bad, 0.2), RangeError, `gross(${bad})`);
      assert.throws(() => net(bad, 0.2), RangeError, `net(${bad})`);
      assert.throws(() => clear(bad, 3000, 0.5), RangeError, `clear(${bad})`);
    }
  });
  test("a fee rate outside [0, 1) or a share outside [0, 1] throws", () => {
    for (const f of [-0.1, 1, 1.5, Number.NaN]) assert.throws(() => gross(2500, f), RangeError, `f=${f}`);
    for (const s of [-0.01, 1.01, Number.NaN]) assert.throws(() => clear(2500, 3000, s), RangeError, `s=${s}`);
  });
  test("a bid below the reserve cannot clear", () => {
    assert.throws(() => clear(3000, 2500, 0.5), RangeError);
  });
});
