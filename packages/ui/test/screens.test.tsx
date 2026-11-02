import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { claudeAi, claudeCode, connectedClients, principalEmail } from "../src/fixtures.js";
import {
  CheckEmailScreen,
  ConnectedClientsScreen,
  ConsentScreen,
  LinkExpiredScreen,
  SignedOutScreen,
  SignInScreen,
} from "../src/index.js";

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ");

describe("screens render each state (task 4.1 acceptance)", () => {
  it("sign-in: labelled email field, error associated with it", () => {
    const html = renderToStaticMarkup(<SignInScreen state="invalid" email="x@example" />);
    const inputId = /<input[^>]*id="([^"]+)"[^>]*type="email"|<input[^>]*type="email"[^>]*id="([^"]+)"/.exec(html);
    expect(inputId).not.toBeNull();
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Email address<\/label>/);
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(text(html)).toContain("Error: Enter an email address in the form name@example.com.");
  });

  it("check-your-email: same markup for any address apart from the address itself", () => {
    const a = renderToStaticMarkup(<CheckEmailScreen email="known@example.com" />).replaceAll("known@example.com", "X");
    const b = renderToStaticMarkup(<CheckEmailScreen email="stranger@example.com" />).replaceAll("stranger@example.com", "X");
    const strip = (h: string) => h.replace(/id="[^"]*"/g, "").replace(/aria-[a-z]+="react-aria[^"]*"/g, "");
    expect(strip(a)).toEqual(strip(b));
  });

  it("check-your-email names the mail sink only on a test stage", () => {
    expect(text(renderToStaticMarkup(<CheckEmailScreen email={principalEmail} />))).not.toContain("mail sink");
    expect(text(renderToStaticMarkup(<CheckEmailScreen email={principalEmail} stageName="pr-52" />))).toContain("mail sink");
  });

  it("expired link offers a new one and says nobody is signed in", () => {
    const t = text(renderToStaticMarkup(<LinkExpiredScreen />));
    expect(t).toContain("you are not signed in");
    expect(t).toContain("Send me a new link");
  });

  it("consent: client name, origin, scopes, the signed-in address, accept and decline; hidden fields never shown", () => {
    const html = renderToStaticMarkup(
      <ConsentScreen
        client={claudeAi}
        scopes={["a2h", "offline_access"]}
        email={principalEmail}
        returnOrigin="claude.ai"
        hiddenFields={{ consent_code: "SECRET-CONSENT-CODE" }}
      />,
    );
    const t = text(html);
    for (const expected of ["Claude", "claude.ai", "Find humans", "Stay connected", principalEmail, "Connect", "Don't connect", "before it is sent"]) {
      expect(t).toContain(expected);
    }
    expect(t).not.toContain("SECRET-CONSENT-CODE");
    expect(html).not.toMatch(/<img/);
  });

  it("consent: a self-registered local client is described in words, not as localhost", () => {
    const t = text(renderToStaticMarkup(<ConsentScreen client={claudeCode} email={principalEmail} returnOrigin="localhost" />));
    expect(t).toContain("a program on this computer");
    expect(t).toContain("A2H has not checked its name");
    expect(t).not.toContain("localhost");
  });

  it("connected apps: rows with disconnect named per client; empty, loading, error states", () => {
    const list = renderToStaticMarkup(<ConnectedClientsScreen email={principalEmail} clients={connectedClients} />);
    expect(list).toContain('aria-label="Disconnect Claude (claude.ai)"');
    expect(text(list)).toContain("not used yet");
    expect(text(renderToStaticMarkup(<ConnectedClientsScreen email={principalEmail} clients={[]} />))).toContain("No apps are connected");
    expect(renderToStaticMarkup(<ConnectedClientsScreen email={principalEmail} state="loading" />)).toContain('aria-busy="true"');
    expect(text(renderToStaticMarkup(<ConnectedClientsScreen email={principalEmail} state="error" />))).toContain("could not be loaded");
  });

  it("connected apps: last use omitted when the server does not track it", () => {
    const withoutLastUse = { ...connectedClients[0]! };
    delete withoutLastUse.lastUsedAt;
    const t = text(renderToStaticMarkup(<ConnectedClientsScreen email={principalEmail} clients={[withoutLastUse]} />));
    expect(t).toContain("Connected 28 Oct 2026");
    expect(t).not.toMatch(/last used|not used yet/);
  });

  it("connected apps: the inline confirmation is a labelled group, no browser dialog", () => {
    const html = renderToStaticMarkup(
      <ConnectedClientsScreen email={principalEmail} clients={connectedClients} rowState={{ clientId: "c-claude-ai", state: "confirming" }} />,
    );
    expect(html).toMatch(/role="group"[^>]*aria-labelledby=/);
    expect(text(html)).toContain("Disconnect Claude?");
    expect(text(html)).toContain("Keep connected");
    expect(html).not.toMatch(/role="(alert)?dialog"/);
  });

  it("signed out says connected apps stay connected", () => {
    expect(text(renderToStaticMarkup(<SignedOutScreen />))).toContain("Apps you connected stay connected");
  });
});
