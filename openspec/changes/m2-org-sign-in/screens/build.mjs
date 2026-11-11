// Builds the static HTML specs of m2-org-sign-in (screens.md). Not production code and not shipped.
//   node openspec/changes/m2-org-sign-in/screens/build.mjs
// No Storybook story exists yet for these screens (this design task changes nothing in packages/ui),
// so the specs are written by hand here instead of exported by packages/ui/scripts/export-screens.mjs.
// Every style comes from packages/ui as it is on this branch (tokens.css, base.css and the CSS modules,
// class names prefixed with their module), except the block marked "Proposed", which sketches the
// components listed as needed in screens.md using semantic tokens only. Once the components and their
// stories exist, these files are replaced by the Storybook export, as in the archived changes.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ui = resolve(here, "../../../../packages/ui/src");
const read = (p) => readFileSync(join(ui, p), "utf8");
const moduleCss = (name, file) => read(file).replace(/\.([A-Za-z_][\w-]*)/g, `.${name}-$1`);

const proposed = `
/* ---- Proposed (components needed, screens.md "Components"): semantic tokens only ---- */
.visuallyHidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
/* AuthShell: links in the header (new prop) */
.AuthShell-nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0 var(--space-4); }
.AuthShell-nav a, .AdminNav-list a { display: inline-flex; align-items: center; min-height: var(--target-min); }
.AuthShell-nav a[aria-current], .AdminNav-list a[aria-current] { color: var(--text); font-weight: var(--weight-strong); text-decoration: none; }
/* AdminNav: People / Record of actions */
.AdminNav-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0 var(--space-5); border-bottom: 1px solid var(--border); font-size: var(--text-md); line-height: var(--leading-md); }
/* PersonRow */
.PersonRow-row { border-bottom: 1px solid var(--border); padding: var(--space-4) 0; display: flex; flex-direction: column; gap: var(--space-3); }
.PersonRow-summary { display: flex; flex-direction: column; gap: var(--space-3); }
.PersonRow-who { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.PersonRow-name { margin: 0; color: var(--text); font-weight: var(--weight-strong); font-size: var(--text-md); line-height: var(--leading-md); overflow-wrap: anywhere; }
.PersonRow-name:focus { outline: none; }
.PersonRow-name:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.PersonRow-you { font-weight: var(--weight-regular); color: var(--text-muted); }
.PersonRow-email { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text); overflow-wrap: anywhere; }
.PersonRow-states { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: var(--space-1) 0 0; }
.PersonRow-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.PersonRow-reason { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); max-width: var(--measure); }
/* PeopleTools: search and the "Show" choice */
.PeopleTools-tools { display: flex; flex-direction: column; gap: var(--space-4); }
.Segments-group { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.Segments-legend { padding: 0; font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: var(--weight-strong); color: var(--text); }
.Segments-options { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.Segments-option { display: inline-flex; align-items: center; gap: var(--space-2); min-height: var(--target-min); box-sizing: border-box; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-md); font-size: var(--text-sm); line-height: var(--leading-sm); font-variant-numeric: tabular-nums; cursor: pointer; }
.Segments-option input { accent-color: var(--accent); margin: 0; width: 1rem; height: 1rem; }
.Segments-option:has(input:checked) { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.Segments-option:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
.PeopleTools-count { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.PeopleTools-more { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; }
/* ActionRecord */
.Record-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border-top: 1px solid var(--border); }
.Record-entry { border-bottom: 1px solid var(--border); padding: var(--space-3) 0; display: flex; flex-direction: column; gap: var(--space-1); }
.Record-what { margin: 0; font-size: var(--text-md); line-height: var(--leading-md); overflow-wrap: anywhere; }
.Record-when { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); font-variant-numeric: tabular-nums; }
.Record-who { margin: 0; font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); overflow-wrap: anywhere; }
/* Sign-in: the two methods on a development stage */
.SignIn-method { display: flex; flex-direction: column; gap: var(--space-4); }
.SignIn-method + .SignIn-method { border-top: 1px solid var(--border); padding-top: var(--space-5); }
`;

const css = [
  read("tokens/tokens.css"),
  read("tokens/base.css"),
  moduleCss("AuthShell", "components/AuthShell.module.css"),
  moduleCss("Screen", "screens/Screen.module.css"),
  moduleCss("Button", "components/Button.module.css"),
  moduleCss("Notice", "components/Notice.module.css"),
  moduleCss("StatusPill", "components/StatusPill.module.css"),
  moduleCss("TextField", "components/TextField.module.css"),
  moduleCss("Skeleton", "components/Skeleton.module.css"),
  moduleCss("ClientRow", "components/ClientRow.module.css"),
  proposed,
].join("\n");

// ---------- pieces ----------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const ME = { name: "Galem L.", email: "galem@example.com" };
const RECORD_HREF = "p14-record.html";

const btn = (label, { variant = "ghost", full = false, type = "button", aria, pending = false, disabled = false, describedby } = {}) =>
  `<button type="${type}" class="Button-button Button-${variant}${full ? " Button-full" : ""}"${aria ? ` aria-label="${esc(aria)}"` : ""}${
    describedby ? ` aria-describedby="${describedby}"` : ""
  }${pending ? ' data-pending aria-busy="true" aria-disabled="true"' : ""}${disabled ? ' data-disabled aria-disabled="true"' : ""}>${label}</button>`;
const btnLink = (label, href, { variant = "primary", full = false } = {}) =>
  `<a class="Button-button Button-${variant}${full ? " Button-full" : ""}" href="${href}">${label}</a>`;
const link = (label, href, current = false) => `<a class="Button-textLink" href="${href}"${current ? ' aria-current="page"' : ""}>${label}</a>`;
const pill = (tone, text) => `<span class="StatusPill-pill StatusPill-${tone}">${text}</span>`;
const notice = (tone, title, body, { role, reference, focusable = false } = {}) =>
  `<div class="Notice-notice Notice-${tone}"${role ? ` role="${role}"` : ""}${focusable ? ' tabindex="-1"' : ""}><p class="Notice-title">${title}</p>${body
    .map((p) => `<p>${p}</p>`)
    .join("")}${reference ? `<span class="Notice-reference">Reference ${reference}</span>` : ""}</div>`;
const skeleton = (h, w) => `<span class="Skeleton-skeleton" style="height:${h}px;width:${w}" aria-hidden="true"></span>`;

function shell({ stage, account = false, admin = false, current, wide = false, body }) {
  const links = admin
    ? `<nav class="AuthShell-nav" aria-label="A2H"><ul><li>${link("Connected apps", "#connected-apps", current === "clients")}</li><li>${link(
        "People and access",
        "p1-people.html",
        current === "admin",
      )}</li></ul></nav>`
    : account
      ? `<nav class="AuthShell-nav" aria-label="A2H"><ul><li>${link("Connected apps", "#connected-apps", current === "clients")}</li></ul></nav>`
      : "";
  const acct = account
    ? `<div class="AuthShell-account">${links}<span>Signed in as <span class="AuthShell-email">${ME.email}</span></span><form method="post">${btn("Sign out", {
        type: "submit",
      })}</form></div>`
    : "";
  return `<div class="AuthShell-page"><header class="AuthShell-banner"><div class="AuthShell-header"><span class="AuthShell-wordmark">A2H</span>${acct}</div>${
    stage ? `<p class="AuthShell-stage" role="note">Test stage ${stage}. Not the live service.</p>` : ""
  }</header><main class="AuthShell-main${wide ? " AuthShell-wide" : ""}">${body}</main></div>`;
}

const h1 = (t) => `<h1 class="Screen-title">${t}</h1>`;
const lead = (t) => `<p class="Screen-lead">${t}</p>`;
const muted = (t) => `<p class="Screen-muted">${t}</p>`;

// ---------- sign-in ----------
const ORG = "your organisation's sign-in";
const orgWords = (name) => (name ? `the ${name} sign-in` : ORG);
const orgForm = (name, { pending = false } = {}) =>
  `<form class="Screen-form" method="post">${btn(pending ? "Opening sign-in…" : `Sign in with ${name ?? "your organisation"}`, {
    variant: "primary",
    full: true,
    type: "submit",
    pending,
  })}</form>`;
const orgFootnote = muted("Who can sign in is decided by your organisation, not by A2H. If it doesn't let you in, contact an administrator.");
const orgLead = (name, purpose) => {
  const go = `You'll go to ${orgWords(name)} to confirm who you are, then come straight back`;
  if (purpose === "connect") return `Sign in to finish connecting your agent. ${go} here.`;
  if (purpose === "approve") return `Sign in to review the question your agent wants to send. ${go} to the question.`;
  return `${go}. A2H never sees or keeps your password.`;
};
const signIn = ({ name, purpose, pending, top = "" } = {}) =>
  shell({ body: [h1("Sign in to A2H"), top, lead(orgLead(name, purpose)), orgForm(name, { pending }), orgFootnote].join("") });

const magicSection = `<section class="SignIn-method" aria-labelledby="m-link"><h2 class="Screen-h2" id="m-link">Test stages only: sign in with a link by email</h2>
<form class="Screen-form" method="post" novalidate><div class="TextField-field"><label class="TextField-label" for="email">Email address</label><input class="TextField-input" id="email" name="email" type="email" inputmode="email" autocomplete="email" spellcheck="false" aria-describedby="email-d"><span class="TextField-description" id="email-d">Only addresses on this stage's list get a link. The link goes to the stage's mail sink, not to a mailbox.</span></div>${btn(
  "Email me a sign-in link",
  { variant: "ghost", full: true, type: "submit" },
)}</form></section>`;
const signInBoth = ({ top = "" } = {}) =>
  shell({
    stage: "dev",
    body: [
      h1("Sign in to A2H"),
      top,
      `<section class="SignIn-method" aria-labelledby="m-org"><h2 class="Screen-h2" id="m-org">Your organisation's sign-in</h2>${lead(orgLead())}${orgForm()}</section>`,
      magicSection,
    ].join(""),
  });

const notCompleted = notice("neutral", "You are not signed in", ["Your organisation's sign-in was not completed. Nothing was changed. You can try again."]);
const sessionEnded = notice("neutral", "Your session has ended", [
  "A2H asks you to sign in again at least every 12 hours. After signing in you come back to the page you were on. If you were in the middle of something there, check that it went through.",
]);

const contactLine = (contact, rest = "") =>
  contact ? `Contact an administrator: <span class="Screen-strong">${contact}</span>.${rest}` : `Contact an administrator.${rest}`;
const refused = (contact) =>
  shell({
    body: [
      h1("A2H could not sign you in"),
      lead("Your organisation's sign-in worked, but A2H can't accept the details it gave for you, so you are not signed in. Nothing was changed."),
      `<p class="Screen-body">This can't be fixed on this page. ${contactLine(contact, " Give them the reference below: it tells them what to correct.")}</p>`,
      `<p class="Screen-muted"><span class="Notice-reference">Reference ref_7b1e94d2c05a4f36</span></p>`,
      `<div class="Screen-actions">${btnLink("Try again", "s1-sign-in.html", { variant: "ghost" })}</div>`,
    ].join(""),
  });
const accessRemoved = (contact) =>
  shell({
    body: [
      h1("You don't have access to A2H"),
      lead("Your organisation's sign-in worked, but an administrator of A2H has removed your access, so you are not signed in."),
      `<p class="Screen-body">Apps you connected can't act for you while your access is removed. Nothing of yours was deleted. To get access back: ${contactLine(contact).replace("Contact", "contact")}</p>`,
      `<div class="Screen-actions">${btnLink("Try again", "s1-sign-in.html", { variant: "ghost" })}</div>`,
    ].join(""),
  });
const unavailable = notice("danger", "Your organisation's sign-in is unavailable", ["A2H could not reach it just now. You are not signed in. Try again in a moment."], { role: "alert" });
const signedOut = (org) =>
  shell({
    body: [
      h1("You're signed out"),
      lead("Apps you connected stay connected: signing out of this page does not disconnect them. To disconnect one, sign in and open Connected apps."),
      org ? `<p class="Screen-body">You are still signed in at your organisation's sign-in. On a shared computer, sign out there too.</p>` : "",
      `<div class="Screen-actions">${btnLink("Sign in again", "s1-sign-in.html", { full: true })}</div>`,
    ].join(""),
  });
const CONTACT = "it-helpdesk@example.com";

// ---------- people ----------
const you = { ...ME, you: true, access: true, admin: true, configured: true };
const marieke = { name: "Marieke Visser", email: "marieke.visser@example.com", access: true, admin: true };
const people6 = [
  you,
  { name: "Ilse de Boer", email: "ilse.deboer@example.com", access: true },
  marieke,
  { name: "Priya Nair", email: "priya.nair@example.com", access: false },
  { name: "Sanne Kok", email: "sanne.kok@example.com", access: true },
  { name: "Tom Aubert", email: "tom.aubert@example.com", access: true },
];
const byName = (a, b) => a.name.localeCompare(b.name, "en");
const who = (p) => `${p.name} (${p.email})`;

const CONFIRM = {
  remove: (p) => ({
    q: `Remove ${p.name}'s access?`,
    body: `They are signed out at once and can't sign in until an administrator restores their access. Apps they connected can no longer act for them; access an app already has ends within an hour. ${
      p.admin ? "They also stop being an administrator while their access is removed, and are one again if it is restored. " : ""
    }Nothing of theirs is deleted. This goes in the record of actions.`,
    yes: "Remove access",
    pending: "Removing…",
    no: "Keep access",
  }),
  restore: (p) => ({
    q: `Restore ${p.name}'s access?`,
    body: `They can sign in again, and apps they connected before work again without asking them anew. ${
      p.wasAdmin ? "They will be an administrator again. " : ""
    }This goes in the record of actions.`,
    yes: "Restore access",
    pending: "Restoring…",
    no: "Keep removed",
  }),
  grant: (p) => ({
    q: `Make ${p.name} an administrator?`,
    body: "They will be able to open this page, remove and restore people's access, and make or withdraw administrators, you included. They will not see anyone's requests, answers or rules. This goes in the record of actions.",
    yes: "Make administrator",
    pending: "Saving…",
    no: "Not now",
  }),
  withdraw: (p) =>
    p.you
      ? {
          q: "Withdraw your own administrator role?",
          body: "You keep your access to A2H but leave this page at once. You can't come back unless another administrator makes you one again. This goes in the record of actions.",
          yes: "Withdraw my role",
          pending: "Saving…",
          no: "Stay an administrator",
        }
      : {
          q: `Withdraw ${p.name}'s administrator role?`,
          body: "They keep their access to A2H but can no longer open this page. This goes in the record of actions.",
          yes: "Withdraw role",
          pending: "Saving…",
          no: "Keep as administrator",
        },
};

function personRow(p, { onlyAdmin = false, state, note = "", focusNote } = {}) {
  const pills = [pill(p.access ? "success" : "neutral", p.access ? "Has access" : "Access removed")];
  if (p.admin) pills.push(pill("neutral", "Administrator"));
  const actions = [];
  const reasons = [];
  if (p.you) reasons.push("You can't remove your own access.");
  else if (p.access) actions.push(btn("Remove access", { aria: `Remove access for ${who(p)}` }));
  else actions.push(btn("Restore access", { aria: `Restore access for ${who(p)}` }));
  if (!p.access) {
    if (p.wasAdmin) reasons.push("Not an administrator while their access is removed. They will be one again if it is restored.");
  } else if (p.admin && p.configured)
    reasons.push(
      p.you
        ? "You are named as an administrator in this install's configuration, so your role can't be withdrawn here."
        : "Named as an administrator in this install's configuration, so the role can't be withdrawn here.",
    );
  else if (p.admin && onlyAdmin) reasons.push("You are the only administrator. Make someone else an administrator before this role can be withdrawn.");
  else if (p.admin) actions.push(btn("Withdraw administrator role", { aria: `Withdraw administrator role from ${who(p)}` }));
  else actions.push(btn("Make administrator", { aria: `Make administrator: ${who(p)}` }));
  const id = `p-${p.email.split("@")[0].replace(/\W/g, "-")}`;
  const confirming = state && CONFIRM[state.split(":")[0]];
  let confirm = "";
  if (confirming) {
    const c = confirming(p);
    const busy = state.endsWith(":pending");
    confirm = `<div class="ClientRow-confirm" role="group" aria-labelledby="${id}-q" tabindex="-1"><p class="ClientRow-question" id="${id}-q">${c.q}</p><p class="ClientRow-body">${c.body}</p><div class="ClientRow-buttons">${btn(
      busy ? c.pending : c.yes,
      { variant: "primary", pending: busy },
    )}${btn(c.no, { disabled: busy })}</div></div>`;
  }
  return `<li class="PersonRow-row"><div class="PersonRow-summary"><div class="PersonRow-who"><h2 class="PersonRow-name"${focusNote ? ' tabindex="-1"' : ""}>${p.name}${
    p.you ? ' <span class="PersonRow-you">(you)</span>' : ""
  }</h2><p class="PersonRow-email">${p.email}</p><p class="PersonRow-states">${pills.join(" ")}</p></div>${
    !confirming && actions.length ? `<div class="PersonRow-actions">${actions.join("")}</div>` : ""
  }</div>${reasons.map((r) => `<p class="PersonRow-reason">${r}</p>`).join("")}${note}${confirm}</li>`;
}

const adminNav = (current) =>
  `<nav aria-label="Administration"><ul class="AdminNav-list"><li>${link("People", "p1-people.html", current === "people")}</li><li>${link(
    "Record of actions",
    RECORD_HREF,
    current === "record",
  )}</li></ul></nav>`;
const peopleLead =
  lead("Everyone who has signed in to A2H. You can remove or restore a person's access and choose who else is an administrator.") +
  muted("Nobody's requests, answers or rules are shown here, to you or to any other administrator. Who can sign in at all is decided in your organisation's sign-in, not on this page.");
const countLine = (text) => `<p class="PeopleTools-count" role="status">${text}</p>`;
const list = (rows) => `<ul class="Screen-list" aria-label="People">${rows.join("")}</ul>`;

const tools = ({ q = "", show = "everyone", counts }) => {
  const opt = (value, label) =>
    `<label class="Segments-option"><input type="radio" name="show" value="${value}"${show === value ? " checked" : ""}>${label}</label>`;
  return `<div class="PeopleTools-tools"><div class="TextField-field"><label class="TextField-label" for="q">Search people</label><input class="TextField-input" id="q" type="search" autocomplete="off" spellcheck="false" value="${esc(
    q,
  )}" aria-describedby="q-d"><span class="TextField-description" id="q-d">By name or email address.</span></div><fieldset class="Segments-group"><legend class="Segments-legend">Show</legend><div class="Segments-options">${opt(
    "everyone",
    `Everyone (${counts.all})`,
  )}${opt("administrators", `Administrators (${counts.admins})`)}${opt("removed", `Access removed (${counts.removed})`)}</div></fieldset></div>`;
};

const peoplePage = (parts, { stage } = {}) =>
  shell({ stage, account: true, admin: true, current: "admin", wide: true, body: [h1("People and access"), adminNav("people"), ...parts].join("") });

const rows6 = (overrides = {}) => [...people6].sort(byName).map((p) => personRow(overrides[p.email]?.person ?? p, overrides[p.email] ?? {}));
const count6 = countLine("6 people · 2 administrators · 1 with access removed");
const recordLink = `This is in the ${link("record of actions", RECORD_HREF)}.`;

// Long list: 214 generated people, the first 50 shown.
const FIRST = ["Aisha", "Anouk", "Bram", "Chloé", "Daan", "Elif", "Emma", "Farid", "Hugo", "Ines", "Jules", "Kenji", "Lea", "Lucas", "Maya", "Noor", "Omar", "Pieter", "Rosa", "Sofia", "Thijs", "Yara"];
const LAST = ["Bakker", "Bernard", "Dubois", "Haddad", "Jansen", "Kaya", "Laurent", "Martin", "Okafor", "Peeters", "Rossi", "Smit", "Tanaka"];
const many = [];
for (let i = 0; many.length < 213; i++) {
  const first = FIRST[i % FIRST.length];
  const last = LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length];
  const name = `${first} ${last}`;
  if (many.some((m) => m.name === name)) continue;
  const n = many.length;
  many.push({
    name,
    email: `${first}.${last}`.toLowerCase().normalize("NFD").replace(/[^a-z.]/g, "") + "@example.com",
    access: n % 43 !== 5,
    admin: n === 30 || n === 120,
  });
}
many.push(you);
many.sort(byName);
const manyCounts = { all: many.length, admins: many.filter((p) => p.admin).length, removed: many.filter((p) => !p.access).length };
const more = (shown, total, label) =>
  `<div class="PeopleTools-more">${countLine(`Showing ${shown} of ${total} ${label}`)}${shown < total ? btn(`Show ${Math.min(50, total - shown)} more`) : ""}</div>`;

const ENTRIES = [
  ["Galem L. removed Sanne Kok's access.", "14:02 on 11 Nov 2026 (UTC+01:00)", "galem@example.com", "sanne.kok@example.com"],
  ["Marieke Visser restored Priya Nair's access.", "11:47 on 11 Nov 2026 (UTC+01:00)", "marieke.visser@example.com", "priya.nair@example.com"],
  ["Marieke Visser withdrew Tom Aubert's administrator role.", "09:15 on 10 Nov 2026 (UTC+01:00)", "marieke.visser@example.com", "tom.aubert@example.com"],
  ["Galem L. removed Priya Nair's access.", "16:30 on 9 Nov 2026 (UTC+01:00)", "galem@example.com", "priya.nair@example.com"],
  ["Tom Aubert withdrew their own administrator role.", "16:02 on 9 Nov 2026 (UTC+01:00)", "tom.aubert@example.com", "tom.aubert@example.com"],
  ["Galem L. made Marieke Visser an administrator.", "10:05 on 9 Nov 2026 (UTC+01:00)", "galem@example.com", "marieke.visser@example.com"],
  ["Galem L. made Tom Aubert an administrator.", "10:04 on 9 Nov 2026 (UTC+01:00)", "galem@example.com", "tom.aubert@example.com"],
];
const recordLead =
  lead("Every time an administrator removed or restored someone's access, or made or withdrew an administrator. Newest first.") +
  muted("Entries can't be changed or deleted, by you or by anyone. Each person is shown with their current name and email address.");
const recordPage = (parts) =>
  shell({ account: true, admin: true, current: "admin", wide: true, body: [h1("People and access"), adminNav("record"), recordLead, ...parts].join("") });
const entry = ([what, when, by, about]) =>
  `<li class="Record-entry"><p class="Record-what">${what}</p><p class="Record-when"><time>${when}</time></p><p class="Record-who">By ${by}${
    by === about ? "" : ` · about ${about}`
  }</p></li>`;

// ---------- screens ----------
const sanne = people6.find((p) => p.name === "Sanne Kok");
const priya = people6.find((p) => p.name === "Priya Nair");
const tom = people6.find((p) => p.name === "Tom Aubert");
const meNotConfigured = { ...you, configured: false };

const screens = [
  ["s1-sign-in", "S1 Sign in, production install: one action, organisation's name not configured", signIn()],
  ["s1b-sign-in-named", "S1 Sign in, production install, organisation's name configured (\"Automi\")", signIn({ name: "Automi" })],
  ["s1c-sign-in-connecting", "S1 Sign in, arriving from an agent's connection", signIn({ purpose: "connect" })],
  ["s1d-sign-in-opening", "S1 Sign in, after pressing: opening the organisation's sign-in", signIn({ pending: true })],
  [
    "s1e-sign-in-error",
    "S1 Sign in could not be started (our side)",
    signIn({
      top: notice("danger", "Sign-in could not be started", ["Something went wrong on our side. You are not signed in. Try again."], {
        role: "alert",
        reference: "ref_3f9a61c2b7d04e18",
      }),
    }),
  ],
  ["s2-sign-in-dev-both", "S2 Sign in, development stage: organisation's sign-in and the magic link", signInBoth()],
  ["s3a-not-completed", "S3a Not signed in: cancelled, or the organisation's sign-in returned an error (neutral)", signIn({ top: notCompleted })],
  ["s3a2-not-completed-dev", "S3a The same on a development stage with both methods", signInBoth({ top: notCompleted })],
  ["s1f-sign-in-unavailable", "S1 The organisation's sign-in cannot be reached", signIn({ top: unavailable })],
  ["s3b-refused", "S3b Refused: the details from the organisation's sign-in can't be accepted (no administrator contact configured)", refused()],
  ["s3b2-refused-contact", "S3b The same, administrator contact configured", refused(CONTACT)],
  ["s3c-access-removed", "S3c Refused: access removed by an administrator (no administrator contact configured)", accessRemoved()],
  ["s3c2-access-removed-contact", "S3c The same, administrator contact configured", accessRemoved(CONTACT)],
  ["s5-signed-out", "S5 Signed out, after signing in through the organisation", signedOut(true)],
  ["s4-session-ended", "S4 Session ended (12 hours, or ended by an administrator): sign in again", signIn({ top: sessionEnded })],

  ["p1-people", "P1 People and access: six people, every kind of row", peoplePage([peopleLead, count6, list(rows6())])],
  [
    "p2-only-you",
    "P2 Empty: only yourself",
    peoplePage([
      peopleLead,
      list([personRow(you, { onlyAdmin: true })]),
      notice("neutral", "You're the only person so far", [
        "People appear here the first time they sign in to A2H. There is nobody to invite or add on this page: your organisation's sign-in decides who can come in.",
      ]),
    ]),
  ],
  [
    "p3-loading",
    "P3 Loading",
    peoplePage([
      peopleLead,
      `<div aria-busy="true" role="status" aria-label="Loading people" class="Screen-stack">${[0, 1, 2, 3]
        .map(() => `<div class="Screen-tight">${skeleton(20, "40%")}${skeleton(16, "55%")}${skeleton(20, "30%")}</div>`)
        .join("")}</div>`,
    ]),
  ],
  [
    "p4-error",
    "P4 Error: the list could not be loaded",
    peoplePage([
      peopleLead,
      notice("danger", "People could not be loaded", ["Nobody's access was changed. Reload the page to try again."], { role: "alert", reference: "ref_8c2e5d1a90b34f67" }),
      `<div class="Screen-actions">${btnLink("Reload", "p1-people.html", { variant: "ghost" })}</div>`,
    ]),
  ],
  [
    "p5-long-list",
    "P5 Long list: 214 people, search, the Show choice, 50 at a time",
    peoplePage([peopleLead, tools({ counts: manyCounts }), list(many.slice(0, 50).map((p) => personRow(p))), more(50, many.length, "people")]),
  ],
  (() => {
    const hits = many.filter((p) => /rossi/i.test(p.name + p.email));
    return [
      "p5b-search",
      "P5b Long list, searched: \"rossi\"",
      peoplePage([peopleLead, tools({ q: "rossi", counts: manyCounts }), list(hits.map((p) => personRow(p))), more(hits.length, hits.length, `people matching “rossi”`)]),
    ];
  })(),
  [
    "p5c-no-match",
    "P5c Long list, search with no match",
    peoplePage([
      peopleLead,
      tools({ q: "zoltan", counts: manyCounts }),
      notice("neutral", "No one matches “zoltan”", ["Check the spelling, or search by email address. Only people who have signed in to A2H at least once are listed."], { role: "status" }),
      `<div class="Screen-actions">${btn("Clear search")}</div>`,
    ]),
  ],
  ["p6-confirm-remove", "P6 Remove access: confirmation", peoplePage([peopleLead, count6, list(rows6({ [sanne.email]: { state: "remove" } }))])],
  ["p6b-removing", "P6b Remove access: confirmed, in progress", peoplePage([peopleLead, count6, list(rows6({ [sanne.email]: { state: "remove:pending" } }))])],
  ["p6c-confirm-remove-admin", "P6c Remove an administrator's access: confirmation", peoplePage([peopleLead, count6, list(rows6({ [marieke.email]: { state: "remove" } }))])],
  [
    "p7-removed",
    "P7 Access removed: said in the row",
    peoplePage([
      peopleLead,
      countLine("6 people · 2 administrators · 2 with access removed"),
      list(
        rows6({
          [sanne.email]: {
            person: { ...sanne, access: false },
            note: notice("success", "Sanne Kok's access is removed", [`They are signed out and can't sign in until access is restored. Access an app already has ends within an hour. ${recordLink}`], {
              role: "status",
            }),
          },
        }),
      ),
    ]),
  ],
  [
    "p7b-removed-admin",
    "P7b An administrator's access removed: said in the row",
    peoplePage([
      peopleLead,
      countLine("6 people · 1 administrator · 2 with access removed"),
      list(
        rows6({
          [marieke.email]: {
            person: { ...marieke, access: false, admin: false, wasAdmin: true },
            note: notice("success", "Marieke Visser's access is removed", [`They are signed out, can't sign in until access is restored, and are not an administrator meanwhile. Access an app already has ends within an hour. ${recordLink}`], {
              role: "status",
            }),
          },
        }),
      ),
    ]),
  ],
  [
    "p8b-confirm-restore-admin",
    "P8b Restore the access of someone who was an administrator: confirmation",
    peoplePage([
      peopleLead,
      countLine("6 people · 1 administrator · 2 with access removed"),
      list(rows6({ [marieke.email]: { person: { ...marieke, access: false, admin: false, wasAdmin: true }, state: "restore" } })),
    ]),
  ],
  ["p8-confirm-restore", "P8 Restore access: confirmation", peoplePage([peopleLead, count6, list(rows6({ [priya.email]: { state: "restore" } }))])],
  ["p9-confirm-grant", "P9 Make administrator: confirmation", peoplePage([peopleLead, count6, list(rows6({ [tom.email]: { state: "grant" } }))])],
  ["p10-confirm-withdraw", "P10 Withdraw administrator role: confirmation", peoplePage([peopleLead, count6, list(rows6({ [marieke.email]: { state: "withdraw" } }))])],
  [
    "p10b-confirm-withdraw-self",
    "P10b Withdraw your own administrator role: confirmation (you are not named in the configuration)",
    peoplePage([peopleLead, count6, list(rows6({ [you.email]: { person: meNotConfigured, state: "withdraw" } }))]),
  ],
  [
    "p11-reasons",
    "P11 Refusals said before the action: own access, the only administrator",
    peoplePage([peopleLead, countLine("3 people · 1 administrator · 0 with access removed"), list([personRow(meNotConfigured, { onlyAdmin: true }), personRow(sanne), personRow(tom)])]),
  ],
  [
    "p11c-configured",
    "P11c Refusals said before the action: administrators named in the configuration (you and another)",
    peoplePage([
      peopleLead,
      countLine("3 people · 2 administrators · 0 with access removed"),
      list([personRow(you), personRow({ name: "Hanna Lind", email: "hanna.lind@example.com", access: true, admin: true, configured: true }), personRow(sanne)]),
    ]),
  ],
  [
    "p11b-refused-last-admin",
    "P11b Refused by the server: withdrawing would leave no administrator (the page was out of date)",
    peoplePage([
      peopleLead,
      countLine("6 people · 1 administrator · 1 with access removed"),
      list(
        rows6({
          [you.email]: {
            person: meNotConfigured,
            onlyAdmin: true,
            note: notice("danger", "You are still an administrator", ["Your role was not withdrawn: A2H would be left with no administrator. Make someone else an administrator first. The list is now up to date."], {
              role: "alert",
              focusable: true,
            }),
          },
          [marieke.email]: { person: { ...marieke, admin: false } },
        }),
      ),
    ]),
  ],
  [
    "p12-action-error",
    "P12 An action did not go through (our side)",
    peoplePage([
      peopleLead,
      count6,
      list(
        rows6({
          [sanne.email]: {
            note: notice("danger", "Sanne Kok still has access", ["Removing access did not go through. Nothing was changed. Try again."], {
              role: "alert",
              focusable: true,
              reference: "ref_51d0c7e2a48b4c39",
            }),
          },
        }),
      ),
    ]),
  ],
  [
    "p13-offline",
    "P13 Offline",
    peoplePage([
      peopleLead,
      notice("neutral", "You're offline", ["This list may be out of date. Changing access needs a connection."], { role: "status" }),
      count6,
      list(rows6()),
    ]),
  ],
  [
    "p14-record",
    "P14 Record of administrator actions",
    recordPage([`<ol class="Record-list" reversed aria-label="Record of actions, newest first">${ENTRIES.map(entry).join("")}</ol>`, more(7, 7, "actions")]),
  ],
  [
    "p14b-record-empty",
    "P14b Record of administrator actions: nothing yet",
    recordPage([notice("neutral", "No actions yet", ["When an administrator removes or restores someone's access, or makes or withdraws an administrator, it is listed here."])]),
  ],
  [
    "n1-not-administrator",
    "N1 A signed-in person who is not an administrator opens the administrators' page",
    shell({
      account: true,
      body: [
        h1("This page is for administrators"),
        lead("You're signed in, but only administrators of A2H in your organisation can open this page. Nothing was changed."),
        `<p class="Screen-body">If someone's access needs changing, contact an administrator.</p>`,
        `<div class="Screen-actions">${btnLink("Go to Connected apps", "#connected-apps", { full: true })}</div>`,
      ].join(""),
    }),
  ],
];

for (const [file, title, body] of screens) {
  writeFileSync(
    join(here, `${file}.html`),
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · A2H spec (m2-org-sign-in)</title>
<!-- Static spec written by Design with screens/build.mjs; described in ../screens.md. Not interactive.
     Styles are packages/ui's own (tokens, base, CSS modules; class names prefixed with their module) plus a
     block marked "Proposed" for components that do not exist yet. Reference width 390 px; resize to check
     320 and 1280. Light or dark follows the system. People and addresses are invented. -->
<style>
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`,
  );
}

writeFileSync(
  join(here, "index.html"),
  `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Organisation sign-in and administrators, static specs · A2H</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 62ch; margin: 2rem auto; padding: 0 1rem; line-height: 1.5">
<h1>Organisation sign-in and administrators: one static spec per state</h1>
<p>Change <code>m2-org-sign-in</code>, described in <code>screens.md</code>. Written by hand with <code>screens/build.mjs</code> from the styles of <code>packages/ui</code>; components that do not exist yet are sketched and listed as needed. Not interactive. Light or dark follows your system setting. People and addresses are invented.</p>
<ol>
${screens.map(([file, title]) => `<li><a href="${file}.html">${esc(title)}</a></li>`).join("\n")}
</ol>
</body>
</html>
`,
);
console.log(`${screens.length} screens written; ${many.length} people in the long list (${manyCounts.admins} administrators, ${manyCounts.removed} removed)`);
