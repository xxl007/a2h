// Simulated participants (spec platform/participant-simulation, design D8).
// Off production only; every simulated handle starts with `sim-` and every
// display label ends with "(simulated)".
import * as z from "zod";

/**
 * Scripted behaviours: `prompt` accepts and answers within its delay;
 * `decline` declines with a reason; `slow` accepts, then answers slowly;
 * `cant_tell` answers with the `cant_tell` verdict; `silent` never responds.
 */
export const SIMULATED_PERSONAS = ["prompt", "decline", "slow", "cant_tell", "silent"] as const;
export const SimulatedPersonaSchema = z.enum(SIMULATED_PERSONAS);
export type SimulatedPersona = z.infer<typeof SimulatedPersonaSchema>;

/** Every simulated handle starts with this. */
export const SIMULATED_HANDLE_PREFIX = "sim-";
/** Every simulated display label ends with this. */
export const SIMULATED_LABEL_SUFFIX = "(simulated)";
/** Each persona's delay is under two minutes on previews (spec "Scripted personas"). */
export const SIMULATED_MAX_DELAY_SECONDS = 119;
