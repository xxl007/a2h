import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { principalEmail } from "../src/fixtures.js";
import {
  AccessRefusedScreen,
  AuthShell,
  ConnectedClientsScreen,
  copy,
  NotAdministratorScreen,
  SignedOutScreen,
  SignInScreen,
  signInWords,
} from "../src/index.js";

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ");
const at = (html: string, s: string) => {
  const i = html.indexOf(s);
  expect(i, `"${s}" is rendered`).toBeGreaterThan(-1);
  return i;
};
const contact = "it-helpdesk@example.com";

describe("sign-in through the organisation (screens.md S1, S2)", () => {
  it("production install: one submit button in a POST form, no email field, no link-by-email wording", () => {
    const html = renderToStaticMarkup(<SignInScreen methods={["organisation"]} next="/approve/A2H-7f3c" nextPurpose="approve" />);
    expect(html).toMatch(/<form[^>]*method="post"/);
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Sign in with your organisation<\/button>/);
    expect(html).toContain('<input type="hidden" name="next" value="/approve/A2H-7f3c"/>');
    expect(html).not.toContain('type="email"');
    expect(text(html)).not.toMatch(/email|link|invited/i);
    expect(text(html)).toContain("then come straight back to the question.");
    expect(text(html)).toContain(copy.orgSignIn.footnote);
  });

  it("the configured organisation's name replaces both wordings", () => {
    const t = text(renderToStaticMarkup(<SignInScreen methods={["organisation"]} organisationName="Automi" />));
    expect(t).toContain("Sign in with Automi");
    expect(t).toContain("You'll go to the Automi sign-in to confirm who you are");
    expect(t).not.toContain("your organisation's sign-in");
    expect(signInWords()).toBe("your organisation's sign-in");
    expect(signInWords("Automi", true)).toBe("The Automi sign-in");
  });

  it("opening: the button says so", () => {
    const html = renderToStaticMarkup(<SignInScreen methods={["organisation"]} organisationPending />);
    expect(text(html)).toContain("Opening sign-in…");
    expect(text(html)).not.toContain("Sign in with your organisation");
  });

  it("both methods: two named sections, two forms, organisation first, the M1 button label kept", () => {
    const html = renderToStaticMarkup(<SignInScreen methods={["organisation", "magic-link"]} stageName="dev" />);
    expect(html.match(/<section/g)).toHaveLength(2);
    expect(html.match(/<form/g)).toHaveLength(2);
    expect(html).toMatch(/<h2[^>]*>Your organisation's sign-in<\/h2>|<h2[^>]*>Your organisation&#x27;s sign-in<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Test stages only: sign in with a link by email<\/h2>/);
    const order = ["Sign in with your organisation", 'type="email"', "Email me a sign-in link"].map((s) => at(html, s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text(html)).toContain(copy.orgSignIn.magicLinkDescription);
    expect(html.match(/aria-labelledby="[^"]+"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("no methods given: the M1 screen as it is", () => {
    const t = text(renderToStaticMarkup(<SignInScreen />));
    expect(t).toContain(copy.signIn.lead);
    expect(t).toContain(copy.signIn.footnote);
    expect(t).not.toContain("organisation");
  });

  it("notices sit between the title and the lead; only errors that follow an action are alerts", () => {
    const render = (notice: "not-completed" | "session-ended" | "start-failed" | "unavailable" | "offline") =>
      renderToStaticMarkup(<SignInScreen methods={["organisation"]} notice={notice} reference="ref_3f9a61c2b7d04e18" />);
    const notCompleted = render("not-completed");
    expect(at(notCompleted, "</h1>")).toBeLessThan(at(notCompleted, "You are not signed in"));
    expect(at(notCompleted, "You are not signed in")).toBeLessThan(at(notCompleted, "You&#x27;ll go to"));
    expect(text(notCompleted)).toContain("Your organisation's sign-in was not completed. Nothing was changed. You can try again.");
    expect(notCompleted).not.toMatch(/role="(alert|status)"/);
    expect(notCompleted).not.toContain("Reference");

    const ended = render("session-ended");
    expect(text(ended)).toContain("Your session has ended");
    expect(text(ended)).toContain("at least every 12 hours");
    expect(ended).not.toMatch(/role="(alert|status)"/);

    const failed = render("start-failed");
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain("Sign-in could not be started");
    expect(text(failed)).toContain("Reference ref_3f9a61c2b7d04e18");

    const unavailable = render("unavailable");
    expect(unavailable).toContain('role="alert"');
    expect(text(unavailable)).toContain("Your organisation's sign-in is unavailable");
    expect(unavailable).not.toContain("Reference");

    expect(render("offline")).toContain('role="status"');
    expect(text(renderToStaticMarkup(<SignInScreen methods={["organisation"]} organisationName="Automi" notice="not-completed" />))).toContain(
      "The Automi sign-in was not completed.",
    );
  });

  it("signed out: one sentence more after an organisation sign-in, and only then", () => {
    expect(text(renderToStaticMarkup(<SignedOutScreen />))).not.toContain("still signed in");
    expect(text(renderToStaticMarkup(<SignedOutScreen organisation />))).toContain(
      "You are still signed in at your organisation's sign-in. On a shared computer, sign out there too.",
    );
    expect(text(renderToStaticMarkup(<SignedOutScreen organisation organisationName="Automi" />))).toContain("at the Automi sign-in.");
  });
});

describe("refusal pages (screens.md S3b, S3c, N1)", () => {
  it("details not accepted: one wording, the reference, one action; no address or name", () => {
    const html = renderToStaticMarkup(<AccessRefusedScreen reason="details" reference="ref_7b1e94d2c05a4f36" />);
    const t = text(html);
    expect(t).toContain("A2H could not sign you in");
    expect(t).toContain("This can't be fixed on this page. Contact an administrator. Give them the reference below: it tells them what to correct.");
    expect(t).toContain("Reference ref_7b1e94d2c05a4f36");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/<a [^>]*href="\/sign-in"[^>]*>Try again<\/a>/);
    expect(t).not.toContain("@");
    expect(t).not.toContain("Signed in as");
  });

  it("access removed: says an administrator removed it, not who, when or why", () => {
    const t = text(renderToStaticMarkup(<AccessRefusedScreen reason="access-removed" organisationName="Automi" />));
    expect(t).toContain("You don't have access to A2H");
    expect(t).toContain("The Automi sign-in worked, but an administrator of A2H has removed your access, so you are not signed in.");
    expect(t).toContain("Nothing of yours was deleted. To get access back: contact an administrator.");
    expect(t).not.toContain("Reference");
  });

  it("the administrator contact is plain strong text, never a link", () => {
    for (const html of [
      renderToStaticMarkup(<AccessRefusedScreen reason="details" administratorContact={contact} reference="ref_1" />),
      renderToStaticMarkup(<AccessRefusedScreen reason="access-removed" administratorContact={contact} />),
      renderToStaticMarkup(<NotAdministratorScreen email={principalEmail} administratorContact={contact} />),
    ]) {
      expect(html).toMatch(new RegExp(`<strong[^>]*>${contact.replace(".", "\\.")}</strong>`));
      expect(html).not.toContain("mailto:");
      for (const anchor of html.match(/<a [^>]*>.*?<\/a>/g) ?? []) expect(anchor).not.toContain(contact);
      expect(text(html)).toMatch(/ontact an administrator: it-helpdesk@example\.com \./);
    }
  });

  it("not an administrator: one primary action to Connected apps, nothing about anyone else", () => {
    const html = renderToStaticMarkup(
      <NotAdministratorScreen email={principalEmail} links={[{ label: "Connected apps", href: "/account/clients" }]} />,
    );
    const t = text(html);
    expect(t).toContain("This page is for administrators");
    expect(t).toContain("If someone's access needs changing, contact an administrator.");
    expect(html).toMatch(/<a [^>]*href="\/account\/clients"[^>]*>Go to Connected apps<\/a>/);
    expect(t).not.toContain("People and access");
  });
});

describe("AuthShell header links", () => {
  const links = [
    { label: "Connected apps", href: "/account/clients" },
    { label: "People and access", href: "/admin/people", current: true },
  ];
  it("a navigation named A2H, before the account, with the current page marked", () => {
    const html = renderToStaticMarkup(
      <AuthShell account={{ email: principalEmail }} links={links}>
        <p>Body</p>
      </AuthShell>,
    );
    expect(html).toContain('<nav aria-label="A2H"');
    expect(at(html, "<nav")).toBeLessThan(at(html, "Signed in as"));
    expect(html).toMatch(/<a [^>]*aria-current="page"[^>]*>People and access<\/a>/);
    expect(html).not.toMatch(/<a [^>]*aria-current="page"[^>]*>Connected apps<\/a>/);
  });
  it("no links, no navigation", () => {
    expect(renderToStaticMarkup(<AuthShell account={{ email: principalEmail }}><p>Body</p></AuthShell>)).not.toContain("<nav");
  });
  it("Connected apps takes the links, and says so after an own role was withdrawn", () => {
    const html = renderToStaticMarkup(<ConnectedClientsScreen email={principalEmail} links={[links[0]!]} notice="own-role-withdrawn" />);
    expect(html).toContain('<nav aria-label="A2H"');
    expect(text(html)).toContain("You are no longer an administrator You keep your access to A2H.");
  });
});
