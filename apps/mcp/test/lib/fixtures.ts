// Shared request_human fixtures: a manifest the seeded leaflet reviewer
// (sim-mv-7f3c, judgment, net reserve 2500, gross 3125 at 20%) accepts, and
// questions for each refusal.

export const ORIGINAL = "Would a patient with type 2 diabetes find the attached leaflet's section on insulin alarming?";
export const EDITED = "Would a newly diagnosed patient find the insulin section alarming? (é, «quotes», 中文)";
export const PUSH_POLL = "Would you still trust this clinic if you learned its director lied about the results?";
export const THIRD_PARTY = "What is your colleague's home address?";
export const LABOUR = "Please write a 2,000-word report on insulin pricing.";

export const BASE = {
  to: "sim-mv-7f3c",
  intent: "judgment",
  audience: "named_individual",
  time_shape: "one_shot",
  format: "single_field",
  question: ORIGINAL,
  lane: "paid",
  bid_minor: 3200,
  currency: "EUR",
  expires_at: "2026-10-29T09:00:00+00:00",
  data_terms: { storage: "principal_workspace", attribution: "attributed", training: "off" },
} as const;
