// Fixture pairs: one value each schema accepts, one it rejects, and the path
// of the field that makes it fail (spec protocol/schemas, "Fixture pair per
// schema"). Values follow the prototypes' A2H-7f3c trace; every name is
// fictional, every amount an integer in minor units.

/** A copy of `obj` without `key`. */
export function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

export const SIG = "A".repeat(85) + "Q=="; // 64 zero-ish bytes, base64 (88 chars)

export const referenceRules = {
  types: [
    { intent: "judgment", accepted: true, reserve_net_minor: 2500, currency: "EUR" },
    { intent: "estimate", accepted: false, reserve_net_minor: 4000, currency: "EUR" },
  ],
  free_lanes: ["own_publications"],
  who_may_ask: "anyone_verified",
  quiet_hours: { start: "22:00", end: "07:00", time_zone: "Europe/Paris" },
  max_interruptions_per_day: 3,
  latency_promise_seconds: 86400,
};

export const referenceInput = {
  to: "sim-mv-7f3c",
  intent: "judgment",
  audience: "named_individual",
  time_shape: "one_shot",
  format: "single_field",
  question: "Is this patient-information leaflet alarming for a newly diagnosed reader?",
  lane: "paid",
  bid_minor: 3500,
  currency: "EUR",
  expires_at: "2026-10-22T16:42:00+02:00",
  data_terms: { storage: "principal_workspace", attribution: "not_attributed", training: "off" },
};

export const referenceManifest = { ...referenceInput, principal_id: "dev-principal-pr-17" };

export const referenceBody = { verdict: "yes", note: { text: "Clear overall; the dosage table should be larger." } };

export const referenceUnsigned = {
  request_id: "A2H-7f3c",
  participant_id: "p_sim_mv",
  body: referenceBody,
  confidence: 4,
  answered_personally: true,
  signed_at: "2026-10-21T09:10:00+02:00",
};

export const referenceEnvelope = { ...referenceUnsigned, key_id: "k-dev-2026-10", signature: SIG };

export const referenceProfile = {
  handle: "sim-mv-7f3c",
  simulated: true,
  topics: [
    { topic: "patient education", evidence: "licence" },
    { topic: "diabetes", evidence: "self_declared" },
  ],
  rating: { rating: 4.8, answers: 48, disputes_lost: 0, typical_latency_seconds: 21600 },
  ranking_display: "4.8 · 48 answers · 0 disputes · ~6h",
  latency_promise_seconds: 86400,
  reserves: [{ request_type: "judgment", reserve_gross_minor: 3125, currency: "EUR" }],
  free_lanes: ["own_publications"],
  identity_verified: true,
};

export const referenceChecked = {
  request_id: "A2H-7f3c",
  status: "answered",
  handle: "sim-mv-7f3c",
  participant_label: "M. V. (simulated)",
  identity_verified: false,
  simulated: true,
  intent: "judgment",
  transitions: {
    sent_at: "2026-10-21T08:42:00+02:00",
    accepted_at: "2026-10-21T08:50:00+02:00",
    answered_at: "2026-10-21T09:10:00+02:00",
  },
  held_minor: 3500,
  hold_status: "captured",
  cleared_minor: 3313,
  currency: "EUR",
  answer: referenceEnvelope,
  answer_display: {
    signature: "a2h:sig:…AQ==",
    citation: "reviewed by M.V., 21 Oct 2026",
    verification_notice: "Answered by a participant who is not yet identity-verified.",
  },
};

type Fixture = { pass: unknown; fail: unknown; path: (string | number)[] };

export const fixtures: Record<string, Fixture> = {
  CurrencySchema: { pass: "EUR", fail: "eur", path: [] },
  MinorAmountSchema: { pass: 3000, fail: 30.5, path: [] },
  DatetimeSchema: { pass: "2026-10-21T16:42:00+02:00", fail: "2026-10-21 16:42", path: [] },
  RequestIdSchema: { pass: "A2H-7f3c", fail: "A2H-7F3C", path: [] },
  HandleSchema: { pass: "sim-mv-7f3c", fail: "MV-7f3c", path: [] },
  IntentSchema: { pass: "judgment", fail: "review", path: [] },
  AudienceSchema: { pass: "named_individual", fail: "everyone", path: [] },
  TimeShapeSchema: { pass: "one_shot", fail: "once", path: [] },
  FormatSchema: { pass: "single_field", fail: "essay", path: [] },
  RequestStatusSchema: { pass: "sent", fail: "pending", path: [] },
  SignedMinorAmountSchema: { pass: -3000, fail: -30.5, path: [] },
  SecondsSchema: { pass: 21600, fail: -1, path: [] },
  OpaqueIdSchema: { pass: "p_sim_mv", fail: "ana@example.org", path: [] },
  LaneSchema: { pass: "paid", fail: "auction", path: [] },
  FreeLaneKindSchema: { pass: "own_publications", fail: "anything", path: [] },
  EvidenceLabelSchema: { pass: "licence", fail: "rumour", path: [] },
  GrossReserveSchema: {
    pass: { request_type: "judgment", reserve_gross_minor: 3125, currency: "EUR" },
    fail: { request_type: "judgment", reserve_gross_minor: 31.25, currency: "EUR" },
    path: ["reserve_gross_minor"],
  },
  TypeRuleSchema: {
    pass: { intent: "judgment", accepted: true, reserve_net_minor: 2500, currency: "EUR" },
    fail: { intent: "judgment", accepted: "yes", reserve_net_minor: 2500, currency: "EUR" },
    path: ["accepted"],
  },
  QuietHoursSchema: {
    pass: { start: "22:00", end: "07:00", time_zone: "Europe/Paris" },
    fail: { start: "25:00", end: "07:00", time_zone: "Europe/Paris" },
    path: ["start"],
  },
  WhoMayAskSchema: { pass: "organisations_only", fail: "anyone", path: [] },
  AnswerBodySchema: { pass: { verdict: "yes" }, fail: { mood: "fine" }, path: [] },
  SignatureSchema: { pass: SIG, fail: "a2h:sig:…c91e", path: [] },
  ProtocolErrorCodeSchema: { pass: "conflict", fail: "quiet_hours", path: [] },
  ProtocolStageSchema: { pass: "lifecycle", fail: "delivery", path: [] },
  ParticipantBlockCodeSchema: { pass: "quiet_hours", fail: "over_budget", path: [] },
  LedgerKindSchema: { pass: "capture", fail: "bonus", path: [] },
  ActorSchema: { pass: "platform", fail: "agent", path: [] },
  LifecycleEventSchema: { pass: "expire", fail: "reopen", path: [] },
  HoldStatusSchema: { pass: "released", fail: "frozen", path: [] },
  TransitionTimesSchema: {
    pass: { sent_at: "2026-10-21T08:42:00+02:00" },
    fail: { sent_at: "2026-10-21T08:42:00+02:00", accepted_at: "soon" },
    path: ["accepted_at"],
  },
  AnswerDisplaySchema: {
    pass: { signature: "a2h:sig:…c91e", citation: "reviewed by M.V., 21 Oct 2026" },
    fail: { signature: "c91e", citation: "reviewed by M.V., 21 Oct 2026" },
    path: ["signature"],
  },
  AttachmentSchema: {
    pass: { ref: "att_1", media_type: "application/pdf", size_bytes: 120000 },
    fail: { ref: "att_1", media_type: "application/pdf", size_bytes: 1.5 },
    path: ["size_bytes"],
  },
  VoiceNoteSchema: {
    pass: { audio_ref: "voice_1", transcript: "Looks fine.", transcript_edited: false },
    fail: { audio_ref: "voice_1", transcript: "Looks fine." },
    path: ["transcript_edited"],
  },
  DataTermsSchema: {
    pass: referenceInput.data_terms,
    fail: { ...referenceInput.data_terms, training: "always" },
    path: ["training"],
  },
  PrincipalSchema: {
    pass: { principal_id: "dev-principal-pr-17", identity_mode: "verified_organisation", verified: true },
    fail: { principal_id: "dev-principal-pr-17", identity_mode: "anonymous", verified: true },
    path: ["identity_mode"],
  },
  TopicSchema: {
    pass: { topic: "patient education", evidence: "licence" },
    fail: { topic: "patient education", evidence: "trust me" },
    path: ["evidence"],
  },
  RatingSummarySchema: {
    pass: referenceProfile.rating,
    fail: { ...referenceProfile.rating, answers: -1 },
    path: ["answers"],
  },
  RulesOfEngagementSchema: {
    pass: referenceRules,
    fail: { ...referenceRules, types: [{ intent: "judgment", accepted: true, reserve_net_minor: 25.5, currency: "EUR" }] },
    path: ["types", 0, "reserve_net_minor"],
  },
  ProfileSchema: {
    pass: referenceProfile,
    fail: { ...referenceProfile, reserves: [{ request_type: "judgment", reserve_gross_minor: 31.25, currency: "EUR" }] },
    path: ["reserves", 0, "reserve_gross_minor"],
  },
  RequestHumanInputSchema: {
    pass: referenceInput,
    fail: { ...referenceInput, bid_minor: 30.5 },
    path: ["bid_minor"],
  },
  ManifestSchema: {
    pass: referenceManifest,
    fail: { ...referenceManifest, bid_minor: 30.5 },
    path: ["bid_minor"],
  },
  ObservationBodySchema: {
    pass: { value: "Open, queue of six", observed_at: "2026-10-21T09:00:00+02:00", place: "Rue de Rivoli 12" },
    fail: { value: "Open", observed_at: "this morning", place: "Rue de Rivoli 12" },
    path: ["observed_at"],
  },
  VerificationBodySchema: { pass: { verdict: "cant_tell" }, fail: { verdict: "maybe" }, path: ["verdict"] },
  JudgmentBodySchema: { pass: referenceBody, fail: { verdict: "probably" }, path: ["verdict"] },
  OpinionBodySchema: { pass: { choice: "b" }, fail: { choice: "" }, path: ["choice"] },
  EstimateBodySchema: {
    pass: { estimate: 12, range: { low: 8, high: 15 }, unit: "weeks" },
    fail: { estimate: 12, range: { low: 8 } },
    path: ["range", "high"],
  },
  KnowledgeBodySchema: { pass: { text: "Use the 2024 guideline." }, fail: { text: 42 }, path: ["text"] },
  AuthorisationBodySchema: { pass: { decision: "approve" }, fail: { decision: "maybe" }, path: ["decision"] },
  ActionBodySchema: { pass: { artifacts: [{ ref: "att_2", media_type: "image/jpeg", size_bytes: 2048 }] }, fail: { artifacts: [] }, path: ["artifacts"] },
  ReferralBodySchema: { pass: { forwarded_to: ["sim-ab-12ef"] }, fail: { forwarded_to: ["ana@example.org"] }, path: ["forwarded_to", 0] },
  UnsignedAnswerSchema: { pass: referenceUnsigned, fail: { ...referenceUnsigned, confidence: 6 }, path: ["confidence"] },
  AnswerEnvelopeSchema: {
    pass: referenceEnvelope,
    fail: { ...referenceEnvelope, answered_personally: false },
    path: ["answered_personally"],
  },
  ProtocolErrorSchema: {
    pass: { code: "outside_participant_rules", stage: "rules", retryable: false, detail: "Outside this participant's published rules." },
    fail: { code: "bid_below_reserve", stage: "rules", retryable: false },
    path: ["code"],
  },
  BlockedManifestSchema: {
    pass: { participant_id: "p_sim_mv", principal_id: "dev-principal-pr-17", stage: "rules", code: "bid_below_reserve", at: "2026-10-21T08:42:00+02:00" },
    fail: { participant_id: "p_sim_mv", principal_id: "dev-principal-pr-17", stage: "rules", code: "Is this alarming?", at: "2026-10-21T08:42:00+02:00" },
    path: ["code"],
  },
  LedgerEntrySchema: {
    pass: { id: "le_1", kind: "hold", account: "principal_wallet", request_id: "A2H-7f3c", amount_minor: -3500, currency: "EUR", created_at: "2026-10-21T08:42:00+02:00", idempotency_key: "A2H-7f3c:hold:1" },
    fail: { id: "le_1", kind: "hold", account: "principal_wallet", request_id: "A2H-7f3c", amount_minor: -35.5, currency: "EUR", created_at: "2026-10-21T08:42:00+02:00", idempotency_key: "A2H-7f3c:hold:1" },
    path: ["amount_minor"],
  },
  RequestEventSchema: {
    pass: { request_id: "A2H-7f3c", from: "sent", to: "accepted", actor: "participant", at: "2026-10-21T08:50:00+02:00" },
    fail: { request_id: "A2H-7f3c", from: "sent", to: "accepted", actor: "agent", at: "2026-10-21T08:50:00+02:00" },
    path: ["actor"],
  },
  FindHumansInputSchema: {
    pass: { topic: "patient information leaflets", request_type: "judgment", attested: true, latency: 86400, max_price_minor: 4000, currency: "EUR" },
    fail: { topic: "patient information leaflets", request_type: "judgment", max_price_minor: 40.5, currency: "EUR" },
    path: ["max_price_minor"],
  },
  FindHumansOutputSchema: {
    pass: { results: [referenceProfile], fee_percent: 20 },
    fail: { results: [{ ...referenceProfile, email: "mv@example.org" }], fee_percent: 20 },
    path: ["results", 0],
  },
  RequestHumanOutputSchema: {
    pass: { status: "sent", request_id: "A2H-7f3c", eta: "2026-10-22T08:42:00+02:00", held_minor: 3500, currency: "EUR", deliver_at: "2026-10-21T08:42:00+02:00", deferred: false },
    fail: { status: "sent", request_id: "A2H-7f3c", eta: "2026-10-22T08:42:00+02:00", held_minor: 35.5, currency: "EUR", deliver_at: "2026-10-21T08:42:00+02:00", deferred: false },
    path: ["held_minor"],
  },
  CheckRequestsInputSchema: { pass: { request_id: "A2H-7f3c" }, fail: { request_id: "A2H-7f3" }, path: ["request_id"] },
  CheckedRequestSchema: { pass: referenceChecked, fail: { ...referenceChecked, status: "done" }, path: ["status"] },
  CheckRequestsOutputSchema: {
    pass: { requests: [referenceChecked] },
    fail: { requests: [{ ...referenceChecked, cleared_minor: 33.13 }] },
    path: ["requests", 0, "cleared_minor"],
  },
};
