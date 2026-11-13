// How long access lasts without a new sign-in at the organisation's identity
// provider (m2-org-sign-in design D6; spec platform/principal-identity "Access
// lasts only while the identity provider vouches"; owner decision 2 at Gate 1,
// 2026-11-11). Durations are whole seconds. They apply to people who signed in
// through the provider only; the caller decides who that is.

/** A web session ends at most 12 hours after the provider sign-in that created it; it is never extended by use. */
export const IDP_SESSION_SECONDS = 43_200;

/** A client's refresh is refused when its principal's last sign-in at the provider is older than 7 days. */
export const IDP_RENEWAL_WINDOW_SECONDS = 604_800;
