// The A2H database schema (task 3.1; design D2, D4, D8). drizzle-kit
// generates migrations/ from this file; .github/scripts/db-migrate.sh applies
// them per stage.
//
// Rules this schema enforces at the database level:
// - Every enum, code and pattern comes from @a2h/protocol; none is spelt here.
// - Tables carry no schema name: the stage's search_path places them (`public`
//   on dev and prod, `pr_<n>` on previews), so one migration set serves all.
// - Money: integers in minor units (`*_minor`), each table with money has a
//   `currency` column. No float anywhere near money.
// - `blocked_manifests` holds ids, stage, code and time only: every column is
//   bounded, the code is one of the participant block codes, no text column.
// - `request_events`, `blocked_manifests`, `request_deliveries` and `answers`
//   are append-only, and
//   `signing_keys` only moves forward (active → rotated → revoked); triggers in
//   migrations/0001_append_only.sql refuse anything else.
import {
  CLOCK_TIME_PATTERN,
  CURRENCY_PATTERN,
  DELIVERY_OUTCOMES,
  FreeLaneKindSchema,
  HANDLE_MAX_LENGTH,
  HANDLE_PATTERN,
  INTENTS,
  OPAQUE_ID_MAX_LENGTH,
  OPAQUE_ID_PATTERN,
  PARTICIPANT_BLOCK_CODES,
  PUBLIC_KEY_PATTERN,
  QUESTION_MAX_LENGTH,
  REQUEST_ID_PATTERN,
  REQUEST_STATUSES,
  SIGNATURE_PATTERN,
  SIGNING_KEY_STATUSES,
  SIMULATED_HANDLE_PREFIX,
  SIMULATED_LABEL_SUFFIX,
  SIMULATED_MAX_DELAY_SECONDS,
  SIMULATED_PERSONAS,
  ActorSchema,
  AudienceSchema,
  FormatSchema,
  LaneSchema,
  LifecycleEventSchema,
  TimeShapeSchema,
  WhoMayAskSchema,
  transition,
} from "@a2h/protocol";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// ---- helpers: constraints built from protocol values -----------------------

/** A SQL string literal. Values come from @a2h/protocol constants, never from input. */
function lit(value: string): SQL {
  return sql.raw(`'${value.replaceAll("'", "''")}'`);
}

/** `col IN ('a', 'b', ...)` over a closed protocol enum. */
function oneOf(col: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${col} IN (${sql.join(values.map(lit), sql`, `)})`;
}

/** `col ~ '<pattern>'`: the protocol's regular expression (POSIX ARE accepts its syntax). */
function matches(col: AnyPgColumn, re: RegExp): SQL {
  return sql`${col} ~ ${lit(re.source)}`;
}

const id = (name: string) => varchar(name, { length: OPAQUE_ID_MAX_LENGTH });
const code = (name: string, values: readonly string[]) => varchar(name, { length: Math.max(...values.map((v) => v.length)) });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const currency = () => char("currency", { length: 3 }).notNull();

/** An approval nonce: 16 random bytes in lower-case hex (apps/mcp request_human). */
export const APPROVAL_NONCE_LENGTH = 32;
const APPROVAL_NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** A short machine code (decline reason): lower-case words joined by `_`, never free text. */
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;
const REASON_CODE_MAX_LENGTH = 40;

/**
 * Every legal (from, to, actor) of the protocol's state machine, derived from
 * `transition()` so the database refuses exactly what the protocol refuses.
 */
const LEGAL_TRANSITIONS: [string, string, string][] = REQUEST_STATUSES.flatMap((from) =>
  ActorSchema.options.flatMap((actor) =>
    LifecycleEventSchema.options.flatMap((event): [string, string, string][] => {
      const r = transition(from, actor, event);
      return r.ok && r.changed ? [[from, r.to, actor]] : [];
    }),
  ),
);

// ---- simulation (design D8; spec platform/participant-simulation) ----------

/** The scripted personas and their delays; seeded on non-production stages only. */
export const simulatedPersonas = pgTable(
  "simulated_personas",
  {
    persona: code("persona", SIMULATED_PERSONAS).primaryKey(),
    delay_seconds: integer("delay_seconds").notNull(),
    decline_reason_code: varchar("decline_reason_code", { length: REASON_CODE_MAX_LENGTH }),
  },
  (t) => [
    check("simulated_personas_persona_known", oneOf(t.persona, SIMULATED_PERSONAS)),
    check("simulated_personas_delay_under_two_minutes", sql`${t.delay_seconds} BETWEEN 1 AND ${sql.raw(String(SIMULATED_MAX_DELAY_SECONDS))}`),
    check("simulated_personas_reason_code", matches(t.decline_reason_code, REASON_CODE_PATTERN)),
    check("simulated_personas_reason_on_decline_only", sql`(${t.persona} = 'decline') = (${t.decline_reason_code} IS NOT NULL)`),
  ],
);

// ---- participants, profiles, rules -----------------------------------------

export const participants = pgTable(
  "participants",
  {
    id: id("id").primaryKey(),
    handle: varchar("handle", { length: HANDLE_MAX_LENGTH }).notNull().unique("participants_handle_unique"),
    /** Revealed to a principal only from `accepted` on (spec request-lifecycle). */
    display_label: varchar("display_label", { length: 80 }).notNull(),
    simulated: boolean("simulated").notNull().default(false),
    persona: code("persona", SIMULATED_PERSONAS).references(() => simulatedPersonas.persona),
    identity_verified: boolean("identity_verified").notNull().default(false),
    created_at: createdAt(),
  },
  (t) => [
    check("participants_id_opaque", matches(t.id, OPAQUE_ID_PATTERN)),
    check("participants_handle_format", matches(t.handle, HANDLE_PATTERN)),
    check("participants_label_not_empty", sql`length(btrim(${t.display_label})) > 0`),
    // Simulation is unmistakable: sim- handle ⇔ simulated ⇔ "(simulated)" label ⇔ persona.
    check(
      "participants_simulated_handle",
      sql`${t.simulated} = (left(${t.handle}, ${sql.raw(String(SIMULATED_HANDLE_PREFIX.length))}) = ${lit(SIMULATED_HANDLE_PREFIX)})`,
    ),
    check(
      "participants_simulated_label",
      sql`${t.simulated} = (right(${t.display_label}, ${sql.raw(String(SIMULATED_LABEL_SUFFIX.length))}) = ${lit(SIMULATED_LABEL_SUFFIX)})`,
    ),
    check("participants_simulated_persona", sql`${t.simulated} = (${t.persona} IS NOT NULL)`),
  ],
);

/** Published terms shown by discovery (protocol ProfileSchema), one row per participant. */
export const profiles = pgTable(
  "profiles",
  {
    participant_id: id("participant_id")
      .primaryKey()
      .references(() => participants.id),
    /** Array of protocol `Topic` ({ topic, evidence }), validated by the writer. */
    topics: jsonb("topics").notNull(),
    /** 0.0 to 5.0; a rating, not money. */
    rating: numeric("rating", { precision: 2, scale: 1, mode: "number" }).notNull(),
    answers_count: integer("answers_count").notNull().default(0),
    disputes_lost: integer("disputes_lost").notNull().default(0),
    typical_latency_seconds: integer("typical_latency_seconds").notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("profiles_topics_array", sql`jsonb_typeof(${t.topics}) = 'array' AND jsonb_array_length(${t.topics}) >= 1`),
    check("profiles_rating_range", sql`${t.rating} BETWEEN 0 AND 5`),
    check("profiles_counts", sql`${t.answers_count} >= 0 AND ${t.disputes_lost} >= 0 AND ${t.typical_latency_seconds} >= 0`),
  ],
);

/** Participant-level rules of engagement (protocol RulesOfEngagementSchema minus `types`). */
export const rules = pgTable(
  "rules",
  {
    participant_id: id("participant_id")
      .primaryKey()
      .references(() => participants.id),
    who_may_ask: code("who_may_ask", WhoMayAskSchema.options).notNull(),
    free_lanes: varchar("free_lanes", { length: 32 }).array().notNull().default(sql`'{}'`),
    quiet_start: varchar("quiet_start", { length: 5 }),
    quiet_end: varchar("quiet_end", { length: 5 }),
    quiet_time_zone: varchar("quiet_time_zone", { length: 64 }),
    max_interruptions_per_day: integer("max_interruptions_per_day").notNull(),
    latency_promise_seconds: integer("latency_promise_seconds").notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("rules_who_may_ask_known", oneOf(t.who_may_ask, WhoMayAskSchema.options)),
    check(
      "rules_free_lanes_known",
      sql`${t.free_lanes} <@ ARRAY[${sql.join(FreeLaneKindSchema.options.map(lit), sql`, `)}]::varchar[]`,
    ),
    check(
      "rules_quiet_hours_complete",
      sql`(${t.quiet_start} IS NULL) = (${t.quiet_end} IS NULL) AND (${t.quiet_start} IS NULL) = (${t.quiet_time_zone} IS NULL)`,
    ),
    check("rules_quiet_start_format", matches(t.quiet_start, CLOCK_TIME_PATTERN)),
    check("rules_quiet_end_format", matches(t.quiet_end, CLOCK_TIME_PATTERN)),
    check("rules_counts", sql`${t.max_interruptions_per_day} >= 0 AND ${t.latency_promise_seconds} >= 0`),
  ],
);

/** Per request type: accepted or not, and the net reserve (protocol TypeRuleSchema). */
export const ruleTypes = pgTable(
  "rule_types",
  {
    participant_id: id("participant_id")
      .notNull()
      .references(() => participants.id),
    intent: code("intent", INTENTS).notNull(),
    accepted: boolean("accepted").notNull(),
    reserve_net_minor: integer("reserve_net_minor").notNull(),
    currency: currency(),
  },
  (t) => [
    primaryKey({ name: "rule_types_pkey", columns: [t.participant_id, t.intent] }),
    check("rule_types_intent_known", oneOf(t.intent, INTENTS)),
    check("rule_types_reserve_non_negative", sql`${t.reserve_net_minor} >= 0`),
    check("rule_types_currency_format", matches(t.currency, CURRENCY_PATTERN)),
  ],
);

// ---- signing keys (design D4; spec protocol/answer-attestation) ------------

/**
 * Public halves of the Ed25519 keys answers are signed with. `participant_id`
 * null: the stage's platform key (this change); per-participant keys arrive
 * with real participants (M2/M3) in the same table.
 */
export const signingKeys = pgTable(
  "signing_keys",
  {
    key_id: id("key_id").primaryKey(),
    participant_id: id("participant_id").references(() => participants.id),
    public_key: varchar("public_key", { length: 44 }).notNull().unique("signing_keys_public_key_unique"),
    status: code("status", SIGNING_KEY_STATUSES).notNull(),
    created_at: createdAt(),
    rotated_at: timestamp("rotated_at", { withTimezone: true }),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check("signing_keys_key_id_opaque", matches(t.key_id, OPAQUE_ID_PATTERN)),
    check("signing_keys_public_key_format", matches(t.public_key, PUBLIC_KEY_PATTERN)),
    check("signing_keys_status_known", oneOf(t.status, SIGNING_KEY_STATUSES)),
    check(
      "signing_keys_status_times",
      sql`CASE ${t.status}
        WHEN 'active' THEN ${t.rotated_at} IS NULL AND ${t.revoked_at} IS NULL
        WHEN 'rotated' THEN ${t.rotated_at} IS NOT NULL AND ${t.revoked_at} IS NULL
        WHEN 'revoked' THEN ${t.revoked_at} IS NOT NULL
      END`,
    ),
    uniqueIndex("signing_keys_one_active")
      .on(sql`(coalesce(${t.participant_id}, ''))`)
      .where(sql`${t.status} = 'active'`),
  ],
);

// ---- requests and their events (spec protocol/request-lifecycle) -----------

export const requests = pgTable(
  "requests",
  {
    id: varchar("id", { length: 16 }).primaryKey(),
    /** The accountable principal of the connection (spec request-approval "Principal recorded"). */
    principal_id: id("principal_id").notNull(),
    participant_id: id("participant_id")
      .notNull()
      .references(() => participants.id),
    intent: code("intent", INTENTS).notNull(),
    audience: code("audience", AudienceSchema.options).notNull(),
    time_shape: code("time_shape", TimeShapeSchema.options).notNull(),
    format: code("format", FormatSchema.options).notNull(),
    lane: code("lane", LaneSchema.options).notNull(),
    free_lane: code("free_lane", FreeLaneKindSchema.options),
    /** The approved question, byte-identical to what the principal accepted. */
    question: text("question").notNull(),
    options: jsonb("options"),
    scale: jsonb("scale"),
    attachments: jsonb("attachments"),
    data_terms: jsonb("data_terms").notNull(),
    /** Gross bid (fee included); the hold equals it. */
    bid_minor: integer("bid_minor").notNull(),
    /** Gross cleared amount, set once when the request is answered. */
    cleared_minor: integer("cleared_minor"),
    currency: currency(),
    status: code("status", REQUEST_STATUSES).notNull().default("sent"),
    deliver_at: timestamp("deliver_at", { withTimezone: true }).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: createdAt(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The nonce of the approval that created this request (design D1): an
     * accepted approval creates one request only, so a replayed approval state
     * is refused (spec request-approval "Accepted approval replayed"). Null
     * for requests not created through an approval.
     */
    approval_nonce: varchar("approval_nonce", { length: APPROVAL_NONCE_LENGTH }),
  },
  (t) => [
    check("requests_id_format", matches(t.id, REQUEST_ID_PATTERN)),
    check("requests_principal_opaque", matches(t.principal_id, OPAQUE_ID_PATTERN)),
    check("requests_intent_known", oneOf(t.intent, INTENTS)),
    check("requests_audience_known", oneOf(t.audience, AudienceSchema.options)),
    check("requests_time_shape_known", oneOf(t.time_shape, TimeShapeSchema.options)),
    check("requests_format_known", oneOf(t.format, FormatSchema.options)),
    check("requests_lane_known", oneOf(t.lane, LaneSchema.options)),
    check("requests_free_lane_known", oneOf(t.free_lane, FreeLaneKindSchema.options)),
    check("requests_status_known", oneOf(t.status, REQUEST_STATUSES)),
    check(
      "requests_question_length",
      sql`length(btrim(${t.question})) > 0 AND char_length(${t.question}) <= ${sql.raw(String(QUESTION_MAX_LENGTH))}`,
    ),
    check("requests_currency_format", matches(t.currency, CURRENCY_PATTERN)),
    check(
      "requests_lane_coherent",
      sql`CASE WHEN ${t.lane} = 'free' THEN ${t.free_lane} IS NOT NULL AND ${t.bid_minor} = 0
          ELSE ${t.free_lane} IS NULL AND ${t.bid_minor} > 0 END`,
    ),
    // Never capture more than the hold; only an answered request has a cleared amount.
    check(
      "requests_cleared",
      sql`${t.cleared_minor} IS NULL OR (${t.status} = 'answered' AND ${t.cleared_minor} BETWEEN 0 AND ${t.bid_minor})`,
    ),
    check("requests_data_terms_object", sql`jsonb_typeof(${t.data_terms}) = 'object'`),
    index("requests_principal_created_idx").on(t.principal_id, t.created_at),
    index("requests_participant_idx").on(t.participant_id),
    index("requests_open_expiry_idx").on(t.expires_at).where(sql`${t.status} IN ('sent', 'accepted')`),
    check("requests_approval_nonce_format", matches(t.approval_nonce, APPROVAL_NONCE_PATTERN)),
    uniqueIndex("requests_approval_nonce_unique").on(t.approval_nonce).where(sql`${t.approval_nonce} IS NOT NULL`),
  ],
);

/** One row per state transition (protocol RequestEventSchema). Append-only. */
export const requestEvents = pgTable(
  "request_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    request_id: varchar("request_id", { length: 16 })
      .notNull()
      .references(() => requests.id),
    from_status: code("from_status", REQUEST_STATUSES),
    to_status: code("to_status", REQUEST_STATUSES).notNull(),
    actor: code("actor", ActorSchema.options).notNull(),
    /** A decline's reason as a short code; never free text. */
    reason_code: varchar("reason_code", { length: REASON_CODE_MAX_LENGTH }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Transitions are idempotent by (request_id, target state): a replay adds no row.
    unique("request_events_request_to_unique").on(t.request_id, t.to_status),
    check(
      "request_events_legal",
      sql`(${t.from_status} IS NULL AND ${t.to_status} = 'sent' AND ${t.actor} = 'principal')
        OR (${t.from_status}, ${t.to_status}, ${t.actor}) IN (${sql.join(
          LEGAL_TRANSITIONS.map(([f, to, a]) => sql`(${lit(f)}, ${lit(to)}, ${lit(a)})`),
          sql`, `,
        )})`,
    ),
    check("request_events_reason_code", matches(t.reason_code, REASON_CODE_PATTERN)),
    check("request_events_reason_on_decline_only", sql`${t.reason_code} IS NULL OR ${t.to_status} = 'declined'`),
  ],
);

/**
 * A manifest blocked by a participant's rules, counted for that participant:
 * ids, stage, code and time only (spec request-approval "Blocked row"). No
 * column can hold text: ids are bounded and pattern-checked, the code is one
 * of the participant block codes. Append-only.
 */
export const blockedManifests = pgTable(
  "blocked_manifests",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Null when the manifest was blocked before a request existed (at approval). */
    request_id: varchar("request_id", { length: 16 }),
    participant_id: id("participant_id")
      .notNull()
      .references(() => participants.id),
    principal_id: id("principal_id").notNull(),
    stage: varchar("stage", { length: 8 }).notNull(),
    code: code("code", PARTICIPANT_BLOCK_CODES).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("blocked_manifests_request_id_format", matches(t.request_id, REQUEST_ID_PATTERN)),
    check("blocked_manifests_principal_opaque", matches(t.principal_id, OPAQUE_ID_PATTERN)),
    check("blocked_manifests_stage_rules", sql`${t.stage} = 'rules'`),
    check("blocked_manifests_code_known", oneOf(t.code, PARTICIPANT_BLOCK_CODES)),
    index("blocked_manifests_participant_at_idx").on(t.participant_id, t.at),
  ],
);

/**
 * The outcome of delivering a request (worker `deliver` queue, task 5.2): one
 * row per request, written when the participant-rules re-validation ran at
 * delivery time. `delivered` rows are what the interruption budget counts;
 * `blocked` goes with a `blocked_manifests` row and the request stays `sent`
 * until it expires. Ids, outcome and time only. Append-only.
 */
export const requestDeliveries = pgTable(
  "request_deliveries",
  {
    request_id: varchar("request_id", { length: 16 })
      .primaryKey()
      .references(() => requests.id),
    participant_id: id("participant_id")
      .notNull()
      .references(() => participants.id),
    outcome: code("outcome", DELIVERY_OUTCOMES).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("request_deliveries_outcome_known", oneOf(t.outcome, DELIVERY_OUTCOMES)),
    index("request_deliveries_participant_at_idx").on(t.participant_id, t.at),
  ],
);

// ---- answers (spec protocol/answer-attestation) ----------------------------

/**
 * The signed envelope as received, one per request. `signed_at` is kept
 * verbatim (text), because the signature covers its exact characters and
 * verification recomputes the canonical payload from stored fields. Append-only.
 */
export const answers = pgTable(
  "answers",
  {
    request_id: varchar("request_id", { length: 16 })
      .primaryKey()
      .references(() => requests.id),
    participant_id: id("participant_id")
      .notNull()
      .references(() => participants.id),
    body: jsonb("body").notNull(),
    confidence: smallint("confidence").notNull(),
    answered_personally: boolean("answered_personally").notNull(),
    signed_at: varchar("signed_at", { length: 40 }).notNull(),
    key_id: id("key_id")
      .notNull()
      .references(() => signingKeys.key_id),
    signature: varchar("signature", { length: 88 }).notNull(),
    stored_at: timestamp("stored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("answers_body_object", sql`jsonb_typeof(${t.body}) = 'object'`),
    check("answers_confidence_range", sql`${t.confidence} BETWEEN 1 AND 5`),
    check("answers_answered_personally", sql`${t.answered_personally} = true`),
    check("answers_signed_at_iso", sql`${t.signed_at} ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$'`),
    check("answers_signature_format", matches(t.signature, SIGNATURE_PATTERN)),
  ],
);

// ---- migration tracking (design D2) ----------------------------------------

/**
 * Which migration files db-migrate.sh applied to this schema. Created by the
 * first migration; db-migrate.sh writes one row per file in the same
 * transaction as the file's statements.
 */
export const schemaMigrations = pgTable("schema_migrations", {
  name: varchar("name", { length: 255 }).primaryKey(),
  /** SHA-256 (hex) of the file as applied; a changed file is refused on re-run. */
  checksum: char("checksum", { length: 64 }).notNull(),
  applied_at: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});
