// The simulated participant set (task 3.2; spec platform/participant-simulation;
// design D8). Seeded on dev and preview stages only, never on prod.
// Every name is fictional; every handle starts with `sim-`; every label ends
// with "(simulated)". Topics are the defaults proposed for Gate 1 decision 3
// and can change here without a spec change.
import type { RatingSummary, RulesOfEngagement, SimulatedPersona, Topic, TypeRule } from "@a2h/protocol";

export interface SeedPersona {
  persona: SimulatedPersona;
  /** Seconds before the simulator acts; under two minutes on previews. */
  delay_seconds: number;
  /** Only the decline persona: the short code its declines carry. */
  decline_reason_code: string | null;
}

export interface SeedParticipant {
  id: string;
  handle: string;
  display_label: string;
  persona: SimulatedPersona;
  identity_verified: boolean;
  topics: Topic[];
  rating: RatingSummary;
  rules: RulesOfEngagement;
}

export const SEED_PERSONAS: readonly SeedPersona[] = [
  { persona: "prompt", delay_seconds: 20, decline_reason_code: null },
  { persona: "decline", delay_seconds: 15, decline_reason_code: "outside_expertise" },
  { persona: "slow", delay_seconds: 100, decline_reason_code: null },
  { persona: "cant_tell", delay_seconds: 30, decline_reason_code: null },
  { persona: "silent", delay_seconds: 60, decline_reason_code: null },
];

const HOUR = 3600;

function eur(intent: TypeRule["intent"], reserve_net_minor: number, accepted = true): TypeRule {
  return { intent, accepted, reserve_net_minor, currency: "EUR" };
}

function rules(types: TypeRule[], extra: Partial<RulesOfEngagement> = {}): RulesOfEngagement {
  return {
    types,
    free_lanes: [],
    who_may_ask: "anyone_verified",
    quiet_hours: null,
    max_interruptions_per_day: 10,
    latency_promise_seconds: 6 * HOUR,
    ...extra,
  };
}

function participant(
  handle: string,
  name: string,
  persona: SimulatedPersona,
  topics: Topic[],
  rating: [number, number, number],
  r: RulesOfEngagement,
  identity_verified = true,
): SeedParticipant {
  return {
    id: `p_${handle.replaceAll("-", "_")}`,
    handle,
    display_label: `${name} (simulated)`,
    persona,
    identity_verified,
    topics,
    rating: { rating: rating[0], answers: rating[1], disputes_lost: 0, typical_latency_seconds: rating[2] },
    rules: r,
  };
}

export const SEED_PARTICIPANTS: readonly SeedParticipant[] = [
  participant(
    "sim-mv-7f3c", "Margaret Vale", "prompt",
    [{ topic: "patient information leaflets", evidence: "job_title" }, { topic: "diabetes patient education", evidence: "licence" }],
    [4.8, 48, 6 * HOUR],
    rules([eur("judgment", 2500), eur("knowledge", 3000), eur("estimate", 4000, false)], { free_lanes: ["own_publications"] }),
  ),
  participant(
    "sim-th-2a91", "Thomas Hartley", "prompt",
    [{ topic: "residential conveyancing in England", evidence: "licence" }],
    [4.6, 31, 8 * HOUR],
    rules([eur("knowledge", 4500), eur("verification", 3500)], { latency_promise_seconds: 12 * HOUR }),
  ),
  participant(
    "sim-ep-5c07", "Eleanor Pryce", "slow",
    [{ topic: "readability of children's books", evidence: "job_title" }, { topic: "picture book editing", evidence: "posts" }],
    [4.9, 22, 20 * HOUR],
    rules([eur("judgment", 2000), eur("opinion", 800)], {
      quiet_hours: { start: "22:00", end: "07:00", time_zone: "Europe/London" },
      latency_promise_seconds: 24 * HOUR,
    }),
  ),
  participant(
    "sim-rc-8d14", "Rupert Cole", "decline",
    [{ topic: "commercial kitchen equipment repair", evidence: "self_declared" }],
    [4.2, 9, 10 * HOUR],
    rules([eur("knowledge", 2500), eur("estimate", 3000)]),
    false,
  ),
  participant(
    "sim-ag-3b62", "Alice Greaves", "cant_tell",
    [{ topic: "small-business bookkeeping and VAT", evidence: "licence" }],
    [4.5, 57, 5 * HOUR],
    rules([eur("knowledge", 3500), eur("verification", 3000)]),
  ),
  participant(
    "sim-jw-9e48", "James Whitlock", "prompt",
    [{ topic: "cycle commuting routes in Bristol", evidence: "posts" }],
    [4.4, 14, 2 * HOUR],
    rules([eur("observation", 1200), eur("opinion", 600)], { free_lanes: ["facts_about_self"], latency_promise_seconds: 4 * HOUR }),
  ),
  participant(
    "sim-hb-1f7d", "Harriet Bloom", "silent",
    [{ topic: "hospital pharmacy dispensing", evidence: "licence" }],
    [4.7, 40, 7 * HOUR],
    rules([eur("verification", 4000), eur("judgment", 3500)], { who_may_ask: "organisations_only" }),
  ),
  participant(
    "sim-ol-6a23", "Oliver Lang", "prompt",
    [{ topic: "web accessibility audits (WCAG)", evidence: "job_title" }],
    [4.8, 63, 4 * HOUR],
    rules([eur("judgment", 3000), eur("verification", 2500), eur("action", 6000)]),
  ),
  participant(
    "sim-cf-4c5e", "Clara Finch", "slow",
    [{ topic: "wedding venue pricing in the Cotswolds", evidence: "self_declared" }],
    [4.3, 11, 18 * HOUR],
    rules([eur("estimate", 2000), eur("opinion", 700)], { latency_promise_seconds: 24 * HOUR }),
    false,
  ),
  participant(
    "sim-dm-7b80", "Daniel Marsh", "decline",
    [{ topic: "secondary school mathematics teaching", evidence: "job_title" }],
    [4.6, 27, 9 * HOUR],
    rules([eur("judgment", 1800), eur("knowledge", 2200), eur("referral", 500)]),
  ),
  participant(
    "sim-ns-0d39", "Nora Sutton", "cant_tell",
    [{ topic: "garden plant diseases", evidence: "posts" }],
    [4.5, 35, 6 * HOUR],
    rules([eur("observation", 1000), eur("knowledge", 1500)]),
  ),
  participant(
    "sim-bk-2e6f", "Benedict Knox", "silent",
    [{ topic: "road freight transit times in Europe", evidence: "job_title" }],
    [4.1, 8, 12 * HOUR],
    rules([eur("estimate", 3500), eur("knowledge", 3000)], { max_interruptions_per_day: 2, latency_promise_seconds: 24 * HOUR }),
  ),
];
