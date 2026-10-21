# ADR 0002: Money model

- Status: accepted (product owner, 2026-10-21)
- Date: 2026-10-21
- Deciders: product owner (Galem L.), PM agent
- Scope: how money is represented, held, cleared, charged and paid out in A2H. Governs `packages/protocol` money shapes, `packages/db` ledger, `apps/worker` settlement jobs, and all money copy.
- Related: PRD §8, §6.2, §6.7, §7.5–7.7, §13.1; CLAUDE.md engineering rules; `docs/research/credits-vs-cash-wallet.md`; `.claude/skills/a2h-protocol` §8.

## Context

A2H moves small amounts (roughly €2–€60 per answer) from a business principal to an individual participant, through a reserve-plus-bid auction, with the platform in the middle. The PRD fixes several points: hold equals bid, a second-price-style clearing between reserve and bid, a platform fee as a percentage of the cleared price taken from the participant side, bounties for the sensor lane, free lanes, release on expiry or decline, a cancellation fee after acceptance, Friday payouts through Stripe Connect, Stripe Identity lagging until payout, disputes resolved within five business days with refunds to the wallet, an append-only ledger with derived balances, and integers in minor units.

Two questions were open when M0 started. First, whether a **credit system** (principals buy credits, participants earn credits redeemable for cash) would create stronger incentives than a cash wallet. A four-track study (`docs/research/credits-vs-cash-wallet.md`, 21 Oct 2026) found that closed-loop credit economies with asymmetric populations hoard or die, that cash outperforms points behaviourally and is what every expert network pays, and that a platform-issued cash-convertible credit is electronic money under EMD2 as applied in France (ACPR authorisation, unwaivable refund at par, full AML programme, financial-liability accounting, Stripe restricted category) with no VAT or DAC7 relief in return. Second, **where and how the fee is shown**: PRD §8 says "taken from the participant side, shown before acceptance", while the participant prototype shows no fee line and says "at least your reserve".

The product owner decided on 21 Oct 2026: plain cash wallet; fee on the participant side; the fee is added on top of what the participant asks and the price shown to principals is the gross price including it, with the breakdown available transparently.

## Decision

1. **Euros, held by Stripe, at every step.** The principal funds a wallet through Stripe (URL-mode elicitation; card details never pass through the client). At send, the bid is authorised as a Stripe PaymentIntent with manual capture (hold = bid). On answer, the clearing price is captured and the remainder of the authorisation is released. The platform fee is a Stripe application fee. Participants are Stripe Connect Express accounts; payouts are transfers batched on Fridays. A2H never holds funds on its own balance sheet and never promises redemption of anything; there is no A2H-issued credit, convertible or not.
2. **Hold = bid.** The number on the "Send · hold €N" button is the principal's worst case. A request is sendable only if `bid_gross ≥ reserve_gross` (see 4).
3. **Provisional clearing rule (v1).** Sealed-bid, ask-side: `clearing = reserve + s × (bid − reserve)`, with `0 ≤ s ≤ 1` a published constant, so `reserve ≤ clearing ≤ bid` always. `bid − clearing` returns to the wallet. The value of `s` is **open** and will be fixed in an ADR before M4 (PRD §13.1); until then the protocol carries `s` as a configuration value and no code assumes a number.
4. **Fee: participant side, gross-to-principal, net-to-participant.** The participant publishes a **net reserve**: the minimum they receive for that request type. The platform fee is a percentage `f` of the cleared price, borne by the participant. Every amount shown to a principal (in `find_humans` results, on the request card, as the hold, as the cleared price) is **gross**, i.e. includes the fee: `reserve_gross = reserve_net / (1 − f)`. Every amount shown to a participant is **net**: what they will actually receive. Both sides can see the breakdown: the request page and the sent screen carry a one-line "includes A2H fee f%" with the gross and net figures, and the fee percentage is published in the terms and in `find_humans` metadata, so that the masking is a presentation default and never a concealment (one rule: nothing hidden from either side; P2B 2019/1150 transparency). The value of `f` is **open** and will be fixed in the same pre-M4 ADR as `s`. This amends PRD §8 wording from "shown before acceptance" to "net amounts to participants, gross amounts to principals, breakdown available on both sides before any commitment"; the PRD is updated when this ADR is accepted.
5. **Bounties (sensor lane).** Fixed gross price per answer; hold = N × price at campaign approval; the first N accepted answers are paid; later answers end `expired` with release.
6. **Free lanes.** €0, no hold, no Stripe objects; a zero-amount ledger row only if a spec scenario requires an audit trail.
7. **Expiry or decline.** Hold released in full, nothing charged, no fee.
8. **Cancel after acceptance.** A cancellation fee is captured from the hold and paid to the participant (net of platform fee); the rest is released. The amount or formula is **open** (pre-M4 ADR).
9. **Payouts and verification.** Friday batch via Connect. Stripe Identity is required for paid lanes but may lag until payout: an unverified participant can accept and answer; the payout job skips them until verified; the principal is told the answer came from a not-yet-verified participant. Payout threshold: none, or at most €10 (study finding: thresholds above one or two answers reproduce points-platform complaints).
10. **Disputes.** Resolved by platform review within five business days; refunds go to the principal's wallet, never to the card.
11. **Ledger.** `ledger_entries` is append-only; balances (wallet available, held, participant pending, participant paid, platform fees) are derived views. Every money move writes its ledger rows and the request state change in **one Postgres transaction**, keyed by an idempotency key `(request_id, kind, sequence)`; a replay is a no-op. Entry kinds: `funding`, `hold`, `release`, `capture`, `fee`, `payout`, `refund`, `cancellation_fee`, `referral_credit`. Each row carries the Stripe object id it mirrors. The ledger mirrors Stripe; it is never the source of truth for a claim against A2H.
12. **Integers in minor units.** Every money field is an integer suffixed `_minor` paired with a 3-letter ISO currency (`EUR` in v1). Gross/net conversion rounds half-up to the minor unit at the edge, once, in `packages/protocol`, and the rounded figures are what both sides see and what the ledger stores.

Invariants (tested as property tests and, where possible, database constraints):
- per request: `hold = release + capture + cancellation_fee`; `capture ≤ hold`; at most one `hold` and one `capture`;
- per answered request: `reserve_gross ≤ capture ≤ bid_gross`; `fee = round(f × capture)`; participant credit `= capture − fee ≥ reserve_net`;
- a derived wallet balance is never negative at any point in the entry sequence; a hold that would make it negative is refused before Stripe is called;
- a `payout` references only `capture − fee` amounts for Identity-verified participants.

## Consequences

- `packages/protocol` carries `reserve_net_minor`, `reserve_gross_minor`, `bid_minor` (gross), `clearing_minor` (gross), `fee_minor`, `participant_net_minor`, and the pure functions `gross(net, f)`, `net(gross, f)`, `clear(reserve, bid, s)`. The fee and share constants are configuration, read by the protocol functions as arguments.
- The participant onboarding "Your rules" screen asks for net reserves ("you receive at least €25"); `find_humans` and the request card show gross; the design skill's money copy (§4e, §4f) changes from "at least your €25 reserve" to the net/gross pattern with the fee line.
- No e-money, payment-institution or AML obligations fall on A2H beyond those Stripe imposes on Connect platforms; KYC on participants is Stripe's regulated duty.
- Operational question deferred to M4 design: per-request manual-capture authorisations (7-day validity for most card networks) versus a prepaid Stripe customer balance for principals; both satisfy this ADR as long as funds stay with Stripe.
- Fee placement on the participant side means the participant's published reserve is net and the auction operates on gross numbers; the spread `s` therefore also splits a gross amount. The pre-M4 ADR must set `s` and `f` together and show both sides a worked example.

## Alternatives rejected

- **Platform-issued convertible credits** (principals buy, participants earn, redeemable for cash): electronic money in France with no offsetting benefit; time-bank and Reddit evidence of hoarding and confiscation backlash. See the study.
- **Non-convertible participant credits** spendable only on A2H: A2H's populations are asymmetric (experts earn, agents spend), so the loop cannot close; experts are paid in money by every comparable network.
- **Euro-pegged "credit" label on the principal wallet**: permitted in principle by the study but not adopted; it adds no measurable incentive for agent buyers and invites scope creep. Revisit only with a product reason.
- **Fee on the principal side, on top** (MTurk, Prolific pattern): rejected by the owner to keep one barrier less on the principal side; transparency is preserved by the breakdown line instead.
- **Fee as a hidden spread** with no breakdown anywhere: rejected; it conflicts with the one rule and with P2B transparency, and gives no VAT advantage over an explicit commission.
- **Floating or discounted credit units for bids**: rejected; arbitrage, devaluation and "charged without result" complaints (Upwork boosts, Reddit tokens).
- **Mutable balance columns** instead of an append-only ledger: rejected by CLAUDE.md; derived balances make every state reconstructible and every replay safe.

## Open items (for the ADR before M4)

1. Clearing share `s` and platform fee `f`, set together with a worked example shown to both sides.
2. Cancellation fee after acceptance.
3. Manual-capture holds vs prepaid Stripe balance for principals.
4. Payout threshold (none vs ≤ €10) and whether micro-entrepreneur social-contribution withholding (French pilot Oct 2026, planned Jan 2027, not yet voted) adds a step to the Friday batch.
5. Stripe's limits on "seller-maintained credits" are irrelevant under this ADR but must be re-checked if a credit label is ever proposed.
