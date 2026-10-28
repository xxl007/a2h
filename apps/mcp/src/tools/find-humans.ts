// find_humans (spec protocol/discovery; protocol skill §7, §10). Reads the
// published profiles and returns ranked handles with their published terms,
// gross prices and the ranking inputs. Writes nothing anywhere: discovery
// leaves no trace on the human side.
import { listPublishedParticipants, type PublishedParticipant } from "@a2h/db";
import {
  FindHumansInputSchema,
  type FindHumansInput,
  type FindHumansOutput,
  gross,
  latencyDisplay,
  type Profile,
  rankingDisplay,
} from "@a2h/protocol";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { errorResult, money, parseArgs, type ToolDeps } from "./common.ts";

/** At most this many profiles per call. */
export const MAX_RESULTS = 10;

export const EMPTY_HINT =
  "No published profile matches. Widen the filters (fewer or broader topic words, a longer latency, " +
  "a higher maximum price, attested off), or ask an existing participant for a referral.";

// Words that say nothing about expertise; they never count as a topical match.
const STOPWORDS = new Set(
  ("about above after again against all also and any are because been before being below between both but can cannot could " +
    "did does doing down during each few find for from further had has have having her here hers him his how into its itself " +
    "just know like more most need needs not now off once only other our out over own person people please same she should " +
    "some someone something such than that the their them then there these they this those through too under until very " +
    "want was were what when where whether which while who whom why will with would you your expert experts help judge question")
    .split(" "),
);

function stem(word: string): string {
  for (const suffix of ["ings", "ing", "es", "s", "ed"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  return word;
}

/** Content words of a text, lower-cased and crudely stemmed. */
export function terms(text: string): Set<string> {
  const words = text.toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map(stem));
}

function sameTerm(a: string, b: string): boolean {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 5 && long.startsWith(short);
}

/** Share of the query's content words found in the profile's topics: 0 (no match) to 1. */
export function topicalFit(query: Set<string>, p: PublishedParticipant): number {
  if (query.size === 0) return 0;
  const topicTerms = [...terms(p.topics.map((t) => t.topic).join(" "))];
  let matched = 0;
  for (const q of query) if (topicTerms.some((t) => sameTerm(q, t))) matched++;
  return matched / query.size;
}

function attested(p: PublishedParticipant): boolean {
  return p.topics.some((t) => t.evidence !== "self_declared");
}

/** Ranking = topical fit × attested expertise × quality × latency fit (protocol skill §10). */
function score(fit: number, p: PublishedParticipant): number {
  const attestedFactor = attested(p) ? 1 : 0.7;
  const quality = Math.max(0.2, p.rating.rating / 5);
  const latencyFit = 1 / (1 + p.rating.typical_latency_seconds / 86_400);
  return fit * attestedFactor * quality * latencyFit;
}

function toProfile(p: PublishedParticipant, feeRate: number): Profile {
  return {
    handle: p.handle,
    simulated: p.simulated,
    topics: p.topics,
    rating: p.rating,
    ranking_display: rankingDisplay(p.rating),
    latency_promise_seconds: p.rules.latency_promise_seconds,
    reserves: p.rules.types
      .filter((t) => t.accepted)
      .map((t) => ({ request_type: t.intent, reserve_gross_minor: gross(t.reserve_net_minor, feeRate), currency: t.currency })),
    free_lanes: p.rules.free_lanes,
    identity_verified: p.identity_verified,
  };
}

/** The published participants matching the filters, best first. Pure over the loaded set. */
export function rank(all: PublishedParticipant[], input: FindHumansInput, feeRate: number): Profile[] {
  const query = terms(input.topic);
  const ranked: Array<{ p: PublishedParticipant; s: number }> = [];
  for (const p of all) {
    const type = p.rules.types.find((t) => t.intent === input.request_type && t.accepted);
    if (!type) continue;
    if (input.currency !== undefined && type.currency !== input.currency) continue;
    if (input.max_price_minor !== undefined && gross(type.reserve_net_minor, feeRate) > input.max_price_minor) continue;
    if (input.attested === true && !attested(p)) continue;
    if (input.latency !== undefined && p.rules.latency_promise_seconds > input.latency) continue;
    const fit = topicalFit(query, p);
    if (fit === 0) continue;
    ranked.push({ p, s: score(fit, p) });
  }
  ranked.sort((a, b) => b.s - a.s || (a.p.handle < b.p.handle ? -1 : 1));
  return ranked.slice(0, MAX_RESULTS).map(({ p }) => toProfile(p, feeRate));
}

const EVIDENCE: Record<string, string> = { self_declared: "self-declared", job_title: "job title", posts: "posts", licence: "licence" };

function render(out: FindHumansOutput, input: FindHumansInput): string {
  if (out.results.length === 0) return `No matching profiles. ${out.hint ?? ""}`.trim();
  const lines = [
    `${out.results.length} matching profile${out.results.length === 1 ? "" : "s"} for ${input.request_type}, best first. ` +
      `Amounts are gross (platform fee ${out.fee_percent}% included). Handles only: names are revealed when a request is accepted.`,
  ];
  out.results.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.handle}${p.simulated ? " (simulated)" : ""} · ${p.ranking_display}`);
    lines.push(`   Topics: ${p.topics.map((t) => `${t.topic} (${EVIDENCE[t.evidence] ?? t.evidence})`).join("; ")}`);
    lines.push(`   Reserves: ${p.reserves.map((r) => `${r.request_type} ${money(r.reserve_gross_minor, r.currency)}`).join(", ")}`);
    lines.push(
      `   Latency promise ${latencyDisplay(p.latency_promise_seconds)} · Free lanes: ${p.free_lanes.length ? p.free_lanes.join(", ").replaceAll("_", " ") : "none"} · ` +
        `${p.identity_verified ? "identity verified" : "identity not yet verified"}`,
    );
  });
  if (input.location !== undefined) lines.push("Note: location is not used for matching yet; no published profile carries one.");
  return lines.join("\n");
}

export async function findHumans(deps: ToolDeps, args: unknown): Promise<{ result: CallToolResult; results: number; code?: string }> {
  const parsed = parseArgs(FindHumansInputSchema, args);
  if (!parsed.ok) return { result: errorResult(parsed.error), results: 0, code: parsed.error.code };
  const input = parsed.data;
  const results = rank(await listPublishedParticipants(deps.db), input, deps.policy.fee_rate);
  const out: FindHumansOutput = {
    results,
    fee_percent: Math.round(deps.policy.fee_rate * 100 * 1e6) / 1e6,
    ...(results.length === 0 ? { hint: EMPTY_HINT } : {}),
  };
  return { result: { content: [{ type: "text", text: render(out, input) }], structuredContent: out }, results: results.length };
}
