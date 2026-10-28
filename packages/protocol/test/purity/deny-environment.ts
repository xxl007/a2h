// Preloaded before the package: clock, randomness, network and timers throw.
// File writes and child processes are denied by Node's permission model
// (--permission with read access only).
function deny(what: string): never {
  throw new Error(`environment access attempted: ${what}`);
}
const RealDate = Date;
class NoClockDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date> | []) {
    if (args.length === 0) deny("new Date()");
    super(...(args));
  }
  static override now(): number {
    return deny("Date.now");
  }
}
globalThis.Date = NoClockDate as DateConstructor;
Math.random = () => deny("Math.random");
globalThis.performance.now = () => deny("performance.now");
globalThis.fetch = () => deny("fetch");
globalThis.setTimeout = (() => deny("setTimeout")) as unknown as typeof setTimeout;
globalThis.setInterval = () => deny("setInterval");
const c = globalThis.crypto;
c.getRandomValues = (() => deny("crypto.getRandomValues"));
c.randomUUID = () => deny("crypto.randomUUID");
c.subtle.generateKey = (() => deny("crypto.subtle.generateKey"));
