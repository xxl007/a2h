// The scripted personas (spec participant-simulation "Scripted personas";
// design D8). Each persona's delay comes from `simulated_personas` (seed,
// under two minutes); this decides what happens when.
import type { SimulatedPersona } from "@a2h/protocol";
import type { SimulateJob } from "./queues.ts";

export interface PersonaStep {
  step: SimulateJob["step"];
  /** Seconds after the previous point in time (delivery for the first step). */
  after_seconds: number;
}

/**
 * - prompt, cant_tell: at the delay, accept and answer at once;
 * - decline: at the delay, decline with the persona's reason code;
 * - slow: accept at a quarter of the delay, answer at the full delay;
 * - silent: at the delay, do nothing; the request expires at its expiry time.
 */
export function personaPlan(persona: SimulatedPersona, delaySeconds: number): PersonaStep[] {
  if (persona === "slow") {
    const accept = Math.max(1, Math.ceil(delaySeconds / 4));
    return [
      { step: "act", after_seconds: accept },
      { step: "answer", after_seconds: Math.max(1, delaySeconds - accept) },
    ];
  }
  return [{ step: "act", after_seconds: delaySeconds }];
}
