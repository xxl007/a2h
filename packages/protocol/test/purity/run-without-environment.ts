// Calls every exported function of the package on reference inputs, under
// deny-environment.ts. Prints which functions ran; any environment access
// throws and fails the parent test.
import * as protocol from "../../src/index.ts";
import { referenceEnvelope, referenceInput, referenceManifest, referenceRules, referenceUnsigned } from "../fixtures.ts";

// A fixed Ed25519 test key pair (RFC 8032, test 1), imported, never generated.
const PKCS8 = Uint8Array.from(Buffer.from("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"));
const RAW_PUBLIC = Uint8Array.from(Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex"));

const facts: protocol.ValidationFacts = {
  now: "2026-10-21T23:30:00+02:00",
  principal: { principal_id: "dev-principal-pr-17", identity_mode: "verified_organisation", verified: true },
  participant: { participant_id: "p_sim_mv", handle: "sim-mv-7f3c", rules: { ...referenceRules, latency_promise_seconds: 3600 } },
  interruptions_today: 0,
  budget: { used_minor: 0, currency: "EUR" },
  requests_today: 0,
  principal_throttled: false,
  approval: "pending",
};
const policy: protocol.ValidationPolicy = {
  fee_rate: 0.2,
  currency: "EUR",
  monthly_budget_minor: 50000,
  per_request_cap_minor: 6000,
  ask_first_above_minor: null,
  daily_request_limit: 20,
  throttled_daily_limit: 2,
};

const priv = await protocol.importPrivateKey(PKCS8);
const pub = await protocol.importPublicKey(RAW_PUBLIC);
const signature = await protocol.signAnswer(referenceUnsigned, priv);

const calls: Record<string, () => unknown> = {
  answerEnvelopeSchemaFor: () => protocol.answerEnvelopeSchemaFor("judgment").parse(referenceEnvelope),
  canonicalAnswerPayload: () => protocol.canonicalAnswerPayload(referenceEnvelope),
  canonicalJson: () => protocol.canonicalJson({ b: 1, a: [2] }),
  citation: () => protocol.citation("M. V.", referenceEnvelope.signed_at),
  classifyForbiddenContent: () => protocol.classifyForbiddenContent(referenceManifest.question),
  clear: () => protocol.clear(2500, 3000, 0.5),
  fee: () => protocol.fee(3125, 0.2),
  formatHandle: () => protocol.formatHandle("mv", new Uint8Array([0x7f, 0x3c])),
  formatRequestId: () => protocol.formatRequestId(new Uint8Array([0x7f, 0x3c])),
  gross: () => protocol.gross(2500, 0.2),
  holdStatusAfter: () => protocol.holdStatusAfter("answered", { paid: true }),
  importPrivateKey: () => priv,
  importPublicKey: () => pub,
  isRequestId: () => protocol.isRequestId("A2H-7f3c"),
  latencyDisplay: () => protocol.latencyDisplay(21600),
  manifestHash: () => protocol.manifestHash(referenceInput),
  net: () => protocol.net(3125, 0.2),
  parseHandle: () => protocol.parseHandle("sim-mv-7f3c"),
  parseRequestId: () => protocol.parseRequestId("A2H-7f3c"),
  rankingDisplay: () => protocol.rankingDisplay({ rating: 4.8, answers: 48, disputes_lost: 0, typical_latency_seconds: 21600 }),
  signAnswer: () => signature,
  signatureDisplay: () => protocol.signatureDisplay(signature),
  verifiesWith: () => [protocol.verifiesWith("rotated"), protocol.verifiesWith("revoked")],
  toJsonSchema: () => protocol.toJsonSchema(protocol.ManifestSchema),
  toolJsonSchemas: () => protocol.toolJsonSchemas(),
  transition: () => protocol.transition("sent", "participant", "accept"),
  validateManifest: () => {
    const r = protocol.validateManifest(referenceManifest, facts, policy);
    if (!r.ok || !r.deferred) throw new Error("expected a deferred delivery");
    return r;
  },
  verifyAnswer: async () => {
    if (!(await protocol.verifyAnswer({ ...referenceEnvelope, signature }, pub))) throw new Error("verification failed");
  },
};

const functions = Object.entries(protocol).filter(([, v]) => typeof v === "function" && !("safeParse" in (v as object))).map(([k]) => k);
for (const name of Object.keys(calls)) await calls[name]!();
process.stdout.write(JSON.stringify({ called: Object.keys(calls), uncalled: functions.filter((f) => !(f in calls)) }));
