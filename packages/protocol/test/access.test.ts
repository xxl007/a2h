// m2-org-sign-in task 3.1 (design D6; spec platform/principal-identity
// "Access lasts only while the identity provider vouches"): how long access
// lasts without a new sign-in at the organisation's identity provider. Owner
// decision 2 at Gate 1 (2026-11-11): 7 days for agents; 12 hours on the web.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDP_RENEWAL_WINDOW_SECONDS, IDP_SESSION_SECONDS } from "../src/index.ts";

test("Scenario: Session reaches twelve hours: a web session from a provider sign-in lasts 12 hours, in whole seconds", () => {
  assert.equal(IDP_SESSION_SECONDS, 43_200);
  assert.equal(IDP_SESSION_SECONDS, 12 * 60 * 60);
});

test("Scenario: Agent renews within the window / after the window: the window is 7 days since the last provider sign-in, in whole seconds", () => {
  assert.equal(IDP_RENEWAL_WINDOW_SECONDS, 604_800);
  assert.equal(IDP_RENEWAL_WINDOW_SECONDS, 7 * 24 * 60 * 60);
});

test("the session is shorter than the renewal window (a signed-in person's agent can always renew)", () => {
  assert.ok(IDP_SESSION_SECONDS < IDP_RENEWAL_WINDOW_SECONDS);
});
