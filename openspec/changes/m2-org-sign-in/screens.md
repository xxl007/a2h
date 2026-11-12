# Screens: m2-org-sign-in

Written by Design after Gate 1 (2026-11-11); updated the same day after the PM's answers and the technical findings (design.md D1–D9, the reworded spec deltas). Sign-in through the organisation's sign-in, what a person sees when it is refused or when their session ends, and the administrators' page. The screens continue the M1 ones (`/sign-in`, `/account/clients`, `/signed-out`): same `AuthShell`, same notices, same inline confirmation as "Disconnect" on Connected apps. Everything not named here is unchanged.

**Static HTML spec per state:** [`screens/index.html`](screens/index.html), one self-contained file per state. Unlike the archived changes, these are **not exported from Storybook**: this task changes nothing in `packages/ui`, so no story exists yet. They are written by hand with [`screens/build.mjs`](screens/build.mjs) from the real `packages/ui` styles (`tokens.css`, `base.css`, the CSS modules, class names prefixed with their module). Components that do not exist yet are sketched in a block marked "Proposed", with semantic tokens only, and listed under "Components". Once the components and stories exist, the Storybook export replaces these files. Not interactive; light or dark follows the system; people and addresses are invented.

| State | Spec |
|---|---|
| S1 Sign in, production install, one action (organisation's name not configured) | [s1-sign-in](screens/s1-sign-in.html) |
| S1 Same, organisation's name configured | [s1b-sign-in-named](screens/s1b-sign-in-named.html) |
| S1 Arriving from an agent's connection | [s1c-sign-in-connecting](screens/s1c-sign-in-connecting.html) |
| S1 After pressing: opening the organisation's sign-in | [s1d-sign-in-opening](screens/s1d-sign-in-opening.html) |
| S1 Sign-in could not be started (our side) | [s1e-sign-in-error](screens/s1e-sign-in-error.html) |
| S1 The organisation's sign-in cannot be reached | [s1f-sign-in-unavailable](screens/s1f-sign-in-unavailable.html) |
| S2 Sign in, development stage, both methods | [s2-sign-in-dev-both](screens/s2-sign-in-dev-both.html) |
| S3a Not signed in: cancelled or an error at the organisation's sign-in (neutral) | [s3a-not-completed](screens/s3a-not-completed.html), [on a development stage](screens/s3a2-not-completed-dev.html) |
| S3b Refused: the details from the organisation's sign-in can't be accepted | [s3b-refused](screens/s3b-refused.html), [with an administrator contact](screens/s3b2-refused-contact.html) |
| S3c Refused: access removed by an administrator | [s3c-access-removed](screens/s3c-access-removed.html), [with an administrator contact](screens/s3c2-access-removed-contact.html) |
| S4 Session ended | [s4-session-ended](screens/s4-session-ended.html) |
| S5 Signed out, after signing in through the organisation | [s5-signed-out](screens/s5-signed-out.html) |
| P1 People and access, every kind of row | [p1-people](screens/p1-people.html) |
| P2 Empty: only yourself | [p2-only-you](screens/p2-only-you.html) |
| P3 Loading | [p3-loading](screens/p3-loading.html) |
| P4 Error: list not loaded | [p4-error](screens/p4-error.html) |
| P5 Long list (214 people): search, "Show", 50 at a time | [p5-long-list](screens/p5-long-list.html), [searched](screens/p5b-search.html), [no match](screens/p5c-no-match.html) |
| P6 Remove access: confirmation, in progress, for an administrator | [p6-confirm-remove](screens/p6-confirm-remove.html), [p6b-removing](screens/p6b-removing.html), [p6c-confirm-remove-admin](screens/p6c-confirm-remove-admin.html) |
| P7 Access removed: said in the row; an administrator's | [p7-removed](screens/p7-removed.html), [p7b-removed-admin](screens/p7b-removed-admin.html) |
| P8 Restore access: confirmation; of someone who was an administrator | [p8-confirm-restore](screens/p8-confirm-restore.html), [p8b-confirm-restore-admin](screens/p8b-confirm-restore-admin.html) |
| P9 Make administrator: confirmation | [p9-confirm-grant](screens/p9-confirm-grant.html) |
| P10 Withdraw administrator role: confirmation; your own | [p10-confirm-withdraw](screens/p10-confirm-withdraw.html), [p10b-confirm-withdraw-self](screens/p10b-confirm-withdraw-self.html) |
| P11 Refusals said before the action: own access, only administrator; named in the configuration | [p11-reasons](screens/p11-reasons.html), [p11c-configured](screens/p11c-configured.html) |
| P11b Refused by the server (the page was out of date) | [p11b-refused-last-admin](screens/p11b-refused-last-admin.html) |
| P12 An action did not go through (our side) | [p12-action-error](screens/p12-action-error.html) |
| P13 Offline | [p13-offline](screens/p13-offline.html) |
| P14 Record of administrator actions; empty | [p14-record](screens/p14-record.html), [p14b-record-empty](screens/p14b-record-empty.html) |
| N1 Not an administrator | [n1-not-administrator](screens/n1-not-administrator.html) |

Narrow screen: every file is the narrow-screen spec at 390 px and reflows down to 320 px with no horizontal scrolling; at 600 px and above the column is 480 px (sign-in) or 640 px (people), as on the M1 screens. There is no table anywhere, so nothing needs a scroll wrapper.

## 0. Roles, words, components

**Roles used** (no new token, no new colour pair; the provisional roles of `tokens.css`): `--surface` (page, header), `--surface-2` (input, confirmation panel, skeletons, pills), `--text` (every name, address, record sentence, heading), `--text-muted` (footnotes, reasons an action is not offered, counts, "(you)", record addresses), `--border` (row dividers, header edge), `--border-strong` (inputs, ghost buttons, confirmation panel, "Show" options), `--accent` (the one primary button per screen, ghost button text, links, the chosen "Show" option's edge), `--on-accent`, `--focus`, the `success`, `neutral` and `danger` status triplets. Type: `--text-xl` title, `--text-md` body, `--text-sm` secondary, `--text-xs` pills; system font. Spacing `--space-1…6`, radius `--radius-md` (controls), `--radius-lg` (notices, confirmation), `--radius-pill`. Motion tokens: only the existing button opacity transition and skeleton pulse, both already under `prefers-reduced-motion: no-preference`.

**Colour roles (skill §3).** A person's name and address are plain `--text` on `--surface`: no tint, no accent (the app names on Connected apps take the accent because an app is a machine; a person never does). Whether someone has access or is an administrator is said in words in a pill, never by colour alone. One accent, on controls and links only.

**The organisation's name.** A2H knows it only when the install sets the optional `ORGANISATION_NAME` (design.md D8); it is never taken from the organisation's sign-in. Two forms, used everywhere the sign-in is named:

| Not configured (default) | Configured, e.g. "Automi" |
|---|---|
| your organisation's sign-in | the Automi sign-in |
| Sign in with your organisation | Sign in with Automi |

"Your organisation" and "an administrator" stay as they are in both cases.

**The administrator contact.** The optional `ADMINISTRATOR_CONTACT` is free text (an address, a channel name). It is shown as plain strong text, never as a link, on S3b, S3c and N1: "Contact an administrator: **{contact}**." Without it the sentence is "Contact an administrator." It can wrap anywhere, so a long value cannot break the layout. Never used in copy: IdP, identity provider, OIDC, SSO, provider, claim, token, session cookie, allow-list, role-based, revoke.

**Components**

| Component | Status | What is needed |
|---|---|---|
| `AuthShell`, `Button`, `ButtonLink`, `TextLink`, `Notice`, `StatusPill`, `TextField`, `Skeleton`, `LocalTime` | exist | used as they are |
| `SignInScreen` | exists, **changes** | new props below; the email form becomes one of two possible methods |
| `AuthShell` header links | **needed** (new prop) | `links?: { label; href; current? }[]` rendered as `<nav aria-label="A2H">` before "Signed in as": "Connected apps" for everyone, "People and access" for administrators only. Current page: `aria-current="page"`, strong, not underlined. 44 px tall. |
| `PersonRow` | **needed** | One person: name (`h2`), address, pills, up to two ghost buttons or the reason an action is not offered. States: idle; confirming (remove, restore, grant, withdraw, withdraw own); in progress; done (success notice in the row); refused by the server (danger notice); failed (danger notice with reference). Built like `ClientRow` (inline confirmation, same focus rules), but the row stays after the action. |
| `PeopleScreen` | **needed** | States: ready, only you, loading, error, offline; with tools once there are more than 10 people. |
| `SearchField` | **needed** | React Aria `SearchField` on the `TextField` styles: visible label, description, clear button, Escape clears. States: empty, filled, no match. |
| `ChoiceGroup` ("Show") | **needed** | React Aria `RadioGroup` drawn as 44 px options with the native radio mark kept visible (the choice is never colour alone). States: each option chosen, focus. If the foundations change already plans a segmented control for the answer form (skill §4f), use that one. |
| `ActionRecord` / `RecordScreen` | **needed** | Ordered list of entries, newest first, read-only. States: entries, empty, loading, error, offline, "Show 50 older". |
| `AdminNav` | **needed** (small) | Two links, "People" and "Record of actions", `<nav aria-label="Administration">`, current marked as above. |
| `AccessRefusedScreen`, `NotAdministratorScreen` | **needed** (compositions only) | Title, lead, body, one action; no new parts. |

**Props for the web dev** (shapes to be confirmed when the components are built):

```ts
// SignInScreen
methods: readonly ("organisation" | "magic-link")[];  // production: ["organisation"] only
organisationName?: string;                            // from configuration; never from the provider's answer
organisationAction?: FormAction;                      // POST; starts the redirect, carries `next`
notice?: "not-completed" | "session-ended" | "start-failed" | "unavailable" | "offline";

// PeopleScreen
people: readonly Person[];                            // everyone who has signed in, sorted by name
interface Person {
  id: string;
  name: string;                                       // the provider's name; the address when it gave none
  email: string;
  hasAccess: boolean;
  isAdministrator: boolean;
  isYou: boolean;
  namedInConfiguration: boolean;                      // administrators only
  administratorOnRestore: boolean;                    // access removed, and named in configuration or still flagged
}
administratorContact?: string;                        // ADMINISTRATOR_CONTACT, also on the refusal pages and N1
onRemoveAccess / onRestoreAccess / onMakeAdministrator / onWithdrawAdministrator:
  (id: string) => Promise<{ ok: true; people: readonly Person[] }
                        | { ok: false; refusal: "own_access" | "last_administrator" | "named_in_configuration"; people: readonly Person[] }>;
// rejects when the action did not go through (P12)

// RecordScreen
entries: readonly { id; action: "access_removed" | "access_restored" | "administrator_made" | "administrator_withdrawn";
                    by: { name; email }; about: { name; email }; at: string /* ISO */ }[];   // current name and address, joined from the account
```

`Person` deliberately has no "last active", "last signed in", request, answer or rules field: the page cannot show what it is never given. The search text never goes into a URL, a log line or a request (see P5).

## S1. Sign in, production install

Route `/sign-in`, as today. Document title "Sign in · A2H". One column, 480 px.

| Element | Copy |
|---|---|
| `h1` | Sign in to A2H |
| Lead | You'll go to your organisation's sign-in to confirm who you are, then come straight back. A2H never sees or keeps your password. |
| Lead, from an agent's connection | Sign in to finish connecting your agent. You'll go to your organisation's sign-in to confirm who you are, then come straight back here. |
| Lead, from an approval link | Sign in to review the question your agent wants to send. You'll go to your organisation's sign-in to confirm who you are, then come straight back to the question. |
| Primary button (full width) | **Sign in with your organisation** |
| Footnote (`--text-muted`) | Who can sign in is decided by your organisation, not by A2H. If it doesn't let you in, contact an administrator. |

No email field, no second action, no magic-link wording anywhere. The M1 footnote "A2H is open to invited addresses only for now." is gone from this screen. The button is a `<form method="post">` submit, so it works without JavaScript; `next` travels as a hidden field as today.

States:
- **Opening (S1d).** After pressing: label "Opening sign-in…", button busy (`aria-busy`, not pressable twice). Nothing else changes; the browser leaves for the organisation's sign-in.
- **Could not be started (S1e).** `danger` notice above the lead, `role="alert"`: "Sign-in could not be started" / "Something went wrong on our side. You are not signed in. Try again." with a reference. Same button below.
- **The organisation's sign-in cannot be reached (S1f).** `danger` notice, `role="alert"`: "Your organisation's sign-in is unavailable" / "A2H could not reach it just now. You are not signed in. Try again in a moment." Same button below; pressing it tries again. No reference: nothing went wrong on our side. On a development stage with both methods the notice sits above both sections and the magic-link form still works.
- **Offline.** `neutral` notice, `role="status"`: "You're offline" / "Signing in needs a connection. Try again when you're back online."
- **Already signed in.** Goes on to `next` or Connected apps, as today.
- **Loading / empty.** None: the page is static and server-rendered.
- **No sign-in configured on a production install.** Not a screen: such an install refuses to start (design.md D8).

Accessibility: focus order is the button only (then the browser's own). The button is 44 px tall and full width. The title is the page's `h1`; nothing is announced on load beyond the document title. Leaving for another site is said in the lead before the button, so the navigation is not a surprise (WCAG 3.2.2).

## S2. Sign in, development stage with both methods

Only where the stage is a development or preview stage **and** a sign-in is configured. Stage line "Test stage dev. Not the live service." as today. Two sections under the `h1`, each a `<section>` named by its `h2`, separated by a `--border` rule:

| Element | Copy |
|---|---|
| `h2` 1 | Your organisation's sign-in |
| Lead, button | as S1 (the button is the screen's one primary) |
| `h2` 2 | Test stages only: sign in with a link by email |
| Field label | Email address |
| Field description | Only addresses on this stage's list get a link. The link goes to the stage's mail sink, not to a mailbox. |
| Button (ghost, full width) | Email me a sign-in link |

The magic-link form keeps its M1 states and copy unchanged (invalid address, "The link was not sent", "Too many attempts", offline, then "Check your email"); its errors appear inside its own section. The ghost button keeps the M1 label, so existing tests find it by name. A development stage with no sign-in configured shows the M1 screen as it is today. A production install can never render section 2 (`methods` has one entry; the spec's test proves the route refuses too).

Accessibility: focus order: organisation button → email field → "Email me a sign-in link". Each form is its own `<form>`; Enter in the email field submits only the magic-link form. Headings give screen-reader users the two methods without reading the whole page.

## S3. Sign-in refused or not completed

Nothing on these pages shows an email address, a name, an error code from the organisation's sign-in, or the reason it gave. None is logged with an address.

### S3a. Not completed (neutral)

Shown for every one of: the person cancelled; the organisation's sign-in returned an error; the answer was not meant for this install, was reused, or did not match the attempt. One wording for all, so the page says nothing about which happened or whether an account exists. It is the sign-in page (S1 or S2) with a `neutral` notice between the title and the lead:

| Element | Copy |
|---|---|
| Document title | Not signed in · A2H |
| Notice title | You are not signed in |
| Notice body | Your organisation's sign-in was not completed. Nothing was changed. You can try again. (Configured name: "The Automi sign-in was not completed.") |

The notice is present on load, so it is not a live region; it is read in order after the `h1`, and the document title says "Not signed in" first. Neutral, not danger: cancelling is not an error.

### S3b. The details from the organisation's sign-in can't be accepted

One page for the three refusals the spec sends to "contact their administrator": no email address or not a confirmed one; an email address another account already has; a person the organisation's sign-in presents as new with an address an existing account has. One wording for all three, so the page cannot tell anyone whether an account with their address exists. What an administrator needs in order to fix it is behind the reference (the cause is logged under it, without the address). No account, no session; neither account is changed.

| Element | Copy |
|---|---|
| Document title | Not signed in · A2H |
| `h1` | A2H could not sign you in |
| Lead | Your organisation's sign-in worked, but A2H can't accept the details it gave for you, so you are not signed in. Nothing was changed. |
| Body, no contact configured | This can't be fixed on this page. Contact an administrator. Give them the reference below: it tells them what to correct. |
| Body, contact configured | This can't be fixed on this page. Contact an administrator: **{contact}**. Give them the reference below: it tells them what to correct. |
| Reference (mono role, `--text-muted`) | Reference ref_… |
| Action (ghost link-button) | Try again |

### S3c. Access removed by an administrator

Shown only after the organisation's sign-in has confirmed who the person is, so it tells the account's own holder and nobody else. It does not say who removed the access, when, or why.

| Element | Copy |
|---|---|
| Document title | No access · A2H |
| `h1` | You don't have access to A2H |
| Lead | Your organisation's sign-in worked, but an administrator of A2H has removed your access, so you are not signed in. |
| Body, no contact configured | Apps you connected can't act for you while your access is removed. Nothing of yours was deleted. To get access back: contact an administrator. |
| Body, contact configured | … To get access back: contact an administrator: **{contact}**. |
| Action (ghost link-button) | Try again |

No administrator is named on either page: A2H must not show other people to someone who is not signed in. The configured contact is the install's own text.

Accessibility (S3a–c): one `h1`, one action, 44 px. Focus order: the one action. The contact and the reference are selectable text, so they can be copied. Status in words in the title; no colour carries meaning. No motion.

## S4. Session ended

When a signed-in person's session is no longer valid (12 hours after sign-in, or ended at once because an administrator removed their access), the next page they open, or the next action they take, lands on the sign-in page with a `neutral` notice. `next` is kept so they return to the page they were on.

| Element | Copy |
|---|---|
| Document title | Sign in again · A2H |
| Notice title | Your session has ended |
| Notice body | A2H asks you to sign in again at least every 12 hours. After signing in you come back to the page you were on. If you were in the middle of something there, check that it went through. |
| Rest | S1 (or S2 on a development stage) |

One wording for both causes: the page cannot and must not tell a person whose access was removed anything before they have signed in at the organisation's sign-in again (then S3c). If the organisation's own session is still alive, pressing the button brings them straight back without typing anything; if the organisation no longer accepts them, they get S3a.

Why a page and not a silent trip to the organisation's sign-in: an action in flight (Send on an approval page, Remove access) cannot be replayed after the trip, so the person has to be told to check it; and nobody is sent to another site without having pressed something. The spec scenario now says the same.

A person who never had a session, or signed out themselves, sees plain S1 with no notice.

Accessibility: as S3a (notice present on load, read after the `h1`; title announces the state).

## S5. Signed out

`/signed-out` as in M1, with one sentence added for a person who had signed in through the organisation (not after a magic-link session on a development stage):

| Element | Copy |
|---|---|
| `h1`, lead, action | unchanged: "You're signed out" / "Apps you connected stay connected: …" / **Sign in again** |
| Added body | You are still signed in at your organisation's sign-in. On a shared computer, sign out there too. (Configured name: "at the Automi sign-in".) |

The page is shown signed out, so whether to add the sentence travels in the short-lived flash the sign-out action already sets, never in the URL.

## P. Administrators' page: People and access

Routes proposed: `/admin/people` and `/admin/record` (web dev decides). `AuthShell` wide (640 px), header with "Connected apps", "People and access" (current) and the account. `h1` "People and access" on both; under it `AdminNav`: **People** · **Record of actions**. Document titles "People and access · A2H" and "Record of actions · A2H".

### P1. The list

| Element | Copy |
|---|---|
| Lead | Everyone who has signed in to A2H. You can remove or restore a person's access and choose who else is an administrator. |
| Note (`--text-muted`) | Nobody's requests, answers or rules are shown here, to you or to any other administrator. Who can sign in at all is decided in your organisation's sign-in, not on this page. |
| Count line | {n} people · {a} administrators · {r} with access removed (singular: "1 person", "1 administrator") |

Each person is a row (`<li>` in a `<ul aria-label="People">`), sorted by name, A to Z, in the viewer's locale; your own row sits in that order, marked "(you)". No "last active", no dates, no counts of requests.

| Part | Copy |
|---|---|
| Name (`h2`) | the name the organisation's sign-in gave; the address if it gave none; "(you)" after your own |
| Address | the email address |
| Pill, access | **Has access** (`success`) or **Access removed** (`neutral`) |
| Pill, role | **Administrator** (`neutral`), only for administrators |
| Buttons (ghost) | **Remove access** or **Restore access**; **Make administrator** or **Withdraw administrator role** |

Which actions a row offers, and what it says in place of one it does not offer (`--text-muted`, under the pills; this is how the refusals of the spec are said before anyone presses anything):

| Row | Access action | Role action |
|---|---|---|
| Has access, not an administrator | Remove access | Make administrator |
| Access removed | Restore access | none (only a person with access can be made an administrator) |
| Access removed, was an administrator | Restore access | "Not an administrator while their access is removed. They will be one again if it is restored." (question 1) |
| Another administrator | Remove access | Withdraw administrator role |
| Another administrator, named in configuration | Remove access | "Named as an administrator in this install's configuration, so the role can't be withdrawn here." |
| You | "You can't remove your own access." | Withdraw administrator role, or one of the two lines below |
| You, named in configuration | same | "You are named as an administrator in this install's configuration, so your role can't be withdrawn here." |
| You, the only administrator with access | same | "You are the only administrator. Make someone else an administrator before this role can be withdrawn." |

A person whose access is removed shows no "Administrator" pill and is not counted as one. Removing another administrator's access is always offered: the last administrator with access is, by definition, the one looking at the page, and their own access cannot be removed. No disabled buttons: an action that cannot be taken is not a control, it is a sentence saying why.

### P6–P10. Confirmations

Pressing an action opens the confirmation inside the row, in place of the row's buttons (the `ClientRow` pattern: a `role="group"` panel named by its question, on `--surface-2`). No browser dialog, no modal. Primary on the left, the way out beside it.

| Action | Question | Body | Confirm (in progress) | Way out |
|---|---|---|---|---|
| Remove access | Remove {name}'s access? | They are signed out at once and can't sign in until an administrator restores their access. Apps they connected can no longer act for them; access an app already has ends within an hour. Nothing of theirs is deleted. This goes in the record of actions. | Remove access (Removing…) | Keep access |
| Remove an administrator's access (P6c) | same | the same, with this sentence before "Nothing of theirs is deleted": They also stop being an administrator while their access is removed, and are one again if it is restored. | same | same |
| Restore access | Restore {name}'s access? | They can sign in again, and apps they connected before work again without asking them anew. This goes in the record of actions. | Restore access (Restoring…) | Keep removed |
| Restore, was an administrator (P8b) | same | the same, with this sentence before "This goes in the record": They will be an administrator again. | same | same |
| Make administrator | Make {name} an administrator? | They will be able to open this page, remove and restore people's access, and make or withdraw administrators, you included. They will not see anyone's requests, answers or rules. This goes in the record of actions. | Make administrator (Saving…) | Not now |
| Withdraw role | Withdraw {name}'s administrator role? | They keep their access to A2H but can no longer open this page. This goes in the record of actions. | Withdraw role (Saving…) | Keep as administrator |
| Withdraw own role | Withdraw your own administrator role? | You keep your access to A2H but leave this page at once. You can't come back unless another administrator makes you one again. This goes in the record of actions. | Withdraw my role (Saving…) | Stay an administrator |

While in progress the confirm button is busy and the way out is unavailable (P6b). One confirmation open at a time: opening another closes the first.

After it went through, the row shows its new pills and buttons and a `success` notice under them (P7), which stays until the next action in that row or a reload. The count line updates.

| Done | Notice title | Notice body |
|---|---|---|
| Access removed | {name}'s access is removed | They are signed out and can't sign in until access is restored. Access an app already has ends within an hour. This is in the record of actions. (link) |
| An administrator's access removed (P7b) | {name}'s access is removed | They are signed out, can't sign in until access is restored, and are not an administrator meanwhile. Access an app already has ends within an hour. This is in the record of actions. |
| Access restored | {name}'s access is restored | They can sign in again, and apps they connected before work again. This is in the record of actions. |
| Administrator made | {name} is now an administrator | They can open this page from their next visit. This is in the record of actions. |
| Role withdrawn | {name} is no longer an administrator | They keep their access to A2H. This is in the record of actions. |
| Own role withdrawn | (you leave the page) | You land on Connected apps with a `success` notice: "You are no longer an administrator" / "You keep your access to A2H." |

### P11b. Refused by the server

The row sentences above prevent most refusals, but the page can be out of date (another administrator acted meanwhile) and the server always decides. A refusal changes nothing and writes nothing in the record. The row gets a `danger` notice and the whole list is refreshed from the server's answer.

| Refusal | Notice title | Notice body |
|---|---|---|
| Last administrator, withdrawing | {name} is still an administrator / You are still an administrator | {Their / Your} role was not withdrawn: A2H would be left with no administrator. Make someone else an administrator first. The list is now up to date. |
| Last administrator, removing access | {name} still has access | Their access was not removed: A2H would be left with no administrator. The list is now up to date. |
| Named in configuration | {name} is still an administrator | Their role was not withdrawn: they are named as an administrator in this install's configuration, so it can't be withdrawn here. The list is now up to date. |
| Own access | You still have access | You can't remove your own access. Nothing was changed. |
| Already done by someone else | no refusal | the row simply shows the current state, with the `neutral` notice "Already done" / "Another administrator did this a moment ago. The list is now up to date." |

If you are no longer an administrator when you act, you get N1. If your session has ended, S4.

### Other states

- **P2 Empty: only yourself.** Your own row, then a `neutral` notice: "You're the only person so far" / "People appear here the first time they sign in to A2H. There is nobody to invite or add on this page: your organisation's sign-in decides who can come in." No search, no "Show", no count line.
- **P3 Loading.** Title, nav and lead are there at once; four skeleton rows in `--surface-2` inside a `role="status"` region labelled "Loading people". No spinner.
- **P4 Error.** `danger` notice, `role="alert"`: "People could not be loaded" / "Nobody's access was changed. Reload the page to try again." with a reference; ghost "Reload".
- **P12 An action did not go through.** `danger` notice in the row, with a reference; the row's buttons are back. Titles say the state that still holds: "{name} still has access" / "{name}'s access is still removed" / "{name} is not an administrator" / "{name} is still an administrator"; body "{Removing access / Restoring access / Making them an administrator / Withdrawing the role} did not go through. Nothing was changed. Try again."
- **P13 Offline.** `neutral` notice above the list: "You're offline" / "This list may be out of date. Changing access needs a connection." Buttons stay; an attempt ends in P12.
- **Expired / declined / blocked.** Do not apply to this page; session ended is S4.

### P5. Long list: hundreds of people

Shown once there are more than 10 people; below that the list is short enough to read.

| Element | Copy |
|---|---|
| Search field label | Search people |
| Description | By name or email address. |
| "Show" (one choice of three) | Everyone ({n}) · Administrators ({a}) · Access removed ({r}) |
| Under the list | Showing {shown} of {total} people |
| Button (ghost) | Show 50 more (or "Show {k} more" for the last, smaller step) |
| Searched | Showing {m} of {m} people matching “{text}” |
| No match (notice, `neutral`) | No one matches “{text}” / Check the spelling, or search by email address. Only people who have signed in to A2H at least once are listed. Ghost button: Clear search |

How it works: the server sends the whole list; the page shows the first 50 and filters in the browser as the person types (name or address, case and accents ignored, any part of either). "Show" and the search combine. The three counts in "Show" replace the count line of P1. The search text stays in the browser: never in the URL, never sent, never logged (it is a person's name or address). With JavaScript off, the tools are not rendered and the whole list is shown, so nothing is unreachable. This is designed for up to 1,000 people (design.md D7): at that size the page holds at most 50 rows until more are asked for, and filtering stays instant. A larger install needs server-side search, which is outside this change and not designed here.

### P14. Record of administrator actions

Its own page so the people list stays short. Read-only: no control on any entry, no selection, no delete, no edit, no export.

| Element | Copy |
|---|---|
| Lead | Every time an administrator removed or restored someone's access, or made or withdrew an administrator. Newest first. |
| Note (`--text-muted`) | Entries can't be changed or deleted, by you or by anyone. Each person is shown with their current name and email address. |
| Entry, line 1 | {administrator} removed {person}'s access. / … restored {person}'s access. / … made {person} an administrator. / … withdrew {person}'s administrator role. / … withdrew their own administrator role. |
| Entry, line 2 | the time, as elsewhere: "14:02 on 11 Nov 2026 (UTC+01:00)", in the viewer's zone (`LocalTime`) |
| Entry, line 3 (`--text-muted`) | By {administrator's address} · about {person's address} |
| Under the list | Showing {shown} of {total} actions; ghost "Show 50 older" |
| Empty (P14b, `neutral` notice) | No actions yet / When an administrator removes or restores someone's access, or makes or withdraws an administrator, it is listed here. |

Loading, error and offline as the people list ("Loading the record", "The record could not be loaded" / "Nothing was changed. Reload the page to try again.", "You're offline" / "This record may be out of date."). Refused actions never appear. The record holds only these four kinds of action: no sign-ins, no requests, nothing about what a person did in A2H.

### Announcements

| Change | How it is said |
|---|---|
| Confirmation opens | Focus moves to the panel; its `role="group"` name is the question, so the question is read first, then the body, then the buttons |
| Way out, or Escape | Panel closes, focus returns to the button that opened it; nothing announced |
| Action went through | `success` notice in the row, `role="status"` (polite): title and body read once; focus moves to the row's name (`h2`, `tabindex="-1"`), so the next Tab reaches the row's new buttons |
| Refused by the server, or did not go through | `danger` notice in the row, `role="alert"` (assertive); focus moves to the notice |
| Search or "Show" changes the list | the "Showing … of …" line is a polite `role="status"`, updated after typing pauses (about half a second), not per keystroke |
| "Show 50 more" | focus moves to the first newly shown name; the status line says the new count |
| Loading | the `role="status"` region's label, "Loading people" |
| Notices present when the page loads (S3a, S4, P2, P13 on load) | not live regions; read in document order, with the document title carrying the state |

### Keyboard order and focus

Header: Connected apps → People and access → Sign out. Then People → Record of actions → Search people → the "Show" group (one Tab stop, arrow keys move between the three, as any radio group) → for each person in order: access action → role action → … → Show 50 more. In an open confirmation: confirm → way out; Escape closes it from anywhere inside. Enter and Space press every button. Nothing is reachable by pointer only; there is no hover-only content, no drag, no shortcut key. Focus ring 2 px `--focus`, offset 2 px, on every stop. Focus is never lost: after every action it is on the row's name, the notice, or the button that opened the confirmation.

### Accessibility (WCAG 2.2 AA)

- Names of controls contain their visible label and the person, so a list of identical buttons is never ambiguous (2.5.3, 2.4.6): "Remove access for Sanne Kok (sanne.kok@example.com)", "Restore access for …", "Make administrator: …", "Withdraw administrator role from …". The address is included because two people can share a name.
- Each person is a list item with an `h2`, so the list can be travelled by item or by heading. Pills are text.
- Targets: every button, header link, nav link and "Show" option is at least 44 × 44 px at 320, 390 and 1280 px. Links inside a sentence (the record link in a notice) are inline text.
- Confirmations are not modal: no focus trap, the page stays readable, Escape is honoured (3.2.x, 2.1.2).
- Destructive and reversible alike are confirmed; all four actions can be undone by the opposite action, and the confirmation says what happens (3.3.4).
- Reduced motion: nothing on these screens moves. The button opacity transition and skeleton pulse exist only under `prefers-reduced-motion: no-preference`.
- Contrast: no new pair; roles as measured in M1. Dark theme from the same tokens.
- `lang="en"`; times in `<time>`; no information by colour, position or shape alone.

## N1. Not an administrator

A signed-in person who is not an administrator and opens `/admin/people`, `/admin/record` or posts any of their actions gets this page with HTTP 403. Header without the "People and access" link. Nothing about any other person, no count, no administrator's name.

| Element | Copy |
|---|---|
| Document title | For administrators · A2H |
| `h1` | This page is for administrators |
| Lead | You're signed in, but only administrators of A2H in your organisation can open this page. Nothing was changed. |
| Body | If someone's access needs changing, contact an administrator. (Contact configured: "contact an administrator: **{contact}**.") |
| Action (primary link-button) | Go to Connected apps |

The same page is what an administrator sees if their role was withdrawn while they had the page open. A visitor who is not signed in is sent to S1 with `next` kept; after signing in they reach the page if they are an administrator and N1 if not. Focus order: header links → Sign out → the action.

## Never on these screens

A request, an answer, a rule, a pause state, a count of either, or when someone last signed in or was active. An email address or name on any signed-out page. Who removed someone's access, on the page the removed person sees. The words from the organisation's sign-in error. A way to add, invite or delete a person. A control on a record entry. A disabled button without its reason. A second accent, a tint on a person's name. A search text in a URL or a log.

## Prototype and PRD

The prototypes have no organisation sign-in and no administrators' page (they predate ADR 0006), so nothing was reproduced from them and nothing contradicts them. Onboarding screen 1 of the skill (§4g, "Send me a sign-in link", "No app to install, no password") no longer describes a production install: **followed the PRD** (§7.1, §12) and the spec. The skill should be updated when this change is archived. PRD §7.1 says an administrator can "switch a person off" (not discoverable, not reachable); that is m2-first-answer and is not on this page. The wording "Remove access" was chosen so the later "switch off" can sit beside it without confusion.

## Checks run on the static specs (2026-11-11)

Playwright (Chromium 1.64) over the 40 files at 320, 390 and 1280 px, light and dark, reduced motion on: axe-core 4.14 (WCAG 2.0, 2.1, 2.2 A and AA plus best practice), a 44 px target check on every button, link-button, nav link and option, and a horizontal-overflow check. 240 runs, no finding (re-run after the update). Screenshots were read at 390 and 1280 px in both themes.

**Not run:** a keyboard pass. The specs are static HTML with no behaviour, so focus order, focus moves, Escape and live-region announcements above are the specification, not something tested. They are to be tested on Storybook when the components exist and again on the preview. Contrast was checked only by axe against the provisional system-colour tokens.

## Decisions taken with the PM (2026-11-11)

Optional `ORGANISATION_NAME` and `ADMINISTRATOR_CONTACT`, used in copy only. Session ended is the sign-in page with a notice and one press. The access-removed page says an administrator removed the access. An administrator can remove another administrator's access, including one named in the configuration; only one's own access and the last administrator with access are refused; a person named in the configuration cannot have the role withdrawn. The list is loaded whole for up to 1,000 people. The record shows current names and addresses. `/signed-out` gains one sentence for people who signed in through the organisation. A production install without sign-in settings does not start, so it has no screen. The header link "People and access" is shown to administrators only.

**Proposals the owner sees at Gate 2:** the page name "People and access"; "Remove access" / "Restore access"; "Withdraw administrator role". Alternatives if preferred: "Administration"; "Block" / "Unblock"; "Remove administrator".

## Open questions for the PM

1. **Restoring someone who was an administrator.** design.md D7 keeps the administrator flag when access is removed ("an administrator when they have access and are either named or flagged"), so restoring access makes the person an administrator again. The row, the Remove confirmation and the Restore confirmation say so (P6c, P7b, P8b). If removal should clear the flag for people not named in the configuration, those three sentences change and `administratorOnRestore` is true only for people named in the configuration. The spec delta does not say which.
2. **One refusal page for three causes (S3b).** Missing or unconfirmed address, address already used by another account, and a new person with an existing account's address share one wording and a reference; the cause is only in the log under that reference. Confirm that the reference is logged with the cause and without the address, or administrators have nothing to go on.
3. **The administrator contact is shown as plain text**, not as a link, because it may be a channel name. Say if an email address should become a `mailto:` link.
