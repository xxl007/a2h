// Task 5.4 and 5.6 on a stage: spec principal-identity "Consent accepted",
// "Consent declined", "Client revoked", "Resource recorded as audience",
// "Refresh token replayed".
import { expect, test } from "@playwright/test";
import { EMAIL, EMAIL_2, MCP_URL, STAGE } from "./lib/env";
import { catchRedirect, signIn } from "./lib/browser";
import { authorizeUrl, exchangeCode, pkce, refresh, registerClient, verifyAccessToken } from "./lib/oauth";

test("Scenario: Consent accepted, then Client revoked", async ({ page }) => {
  const name = `E2E app ${Date.now()}`;
  const reg = await registerClient(name);
  expect(reg.status).toBe(201);
  const clientId = reg.body["client_id"] as string;
  const { verifier, challenge } = pkce();
  const redirected = await catchRedirect(page);

  await page.goto(authorizeUrl(clientId, challenge));
  await expect(page).toHaveURL(/\/sign-in\?/);
  await expect(page.getByText("Sign in to finish connecting your agent.")).toBeVisible();
  await signIn(page, EMAIL);

  await expect(page).toHaveURL(/\/consent\?/);
  await expect(page).toHaveTitle(`Connect ${name} · A2H`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Let this app act for you on A2H?");
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  await expect(page.getByText("a program on this computer").first()).toBeVisible();
  await expect(page.getByText("This app registered itself. A2H has not checked its name.")).toBeVisible();
  await expect(page.getByText("Find humans, send them approved questions and read their answers on your behalf")).toBeVisible();
  await expect(page.getByText("Stay connected without signing in again")).toBeVisible();
  await expect(page.getByText(`It will act for ${EMAIL}.`)).toBeVisible();
  await expect(page.getByText(`Test stage ${STAGE}. Not the live service.`)).toBeVisible();
  // Never shown: client id, scope identifiers.
  await expect(page.locator("main")).not.toContainText(clientId);
  await expect(page.locator("main")).not.toContainText("offline_access");

  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const back = await redirected();
  expect(back.searchParams.get("state")).toBe("e2e-state");
  const code = back.searchParams.get("code")!;
  expect(code).toBeTruthy();

  const tokens = await exchangeCode(clientId, code, verifier);
  expect(tokens.status).toBe(200);
  const claims = await verifyAccessToken(tokens.body["access_token"] as string);
  expect(claims.aud === MCP_URL || (Array.isArray(claims.aud) && claims.aud[0] === MCP_URL)).toBe(true);
  expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(3600);
  expect(claims.sub).toBeTruthy();

  // Scenario: Refresh token replayed.
  const first = tokens.body["refresh_token"] as string;
  const r1 = await refresh(clientId, first);
  expect(r1.status).toBe(200);
  expect((await refresh(clientId, first)).status).toBe(400);
  expect((await refresh(clientId, r1.body["refresh_token"] as string)).status).toBe(400);

  // A fresh grant for the revoke scenario (the consent is remembered: no second consent screen).
  const again = pkce();
  const direct = await page.request.get(authorizeUrl(clientId, again.challenge), { maxRedirects: 0 });
  expect(direct.status()).toBe(302);
  const code2 = new URL(direct.headers()["location"]!).searchParams.get("code")!;
  const t2 = await exchangeCode(clientId, code2, again.verifier);
  expect(t2.status).toBe(200);

  // Scenario: Client revoked.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.goto("/account/clients");
  const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name }) });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: new RegExp(`^Disconnect ${name}`) }).click();
  await expect(row.getByText(`Disconnect ${name}?`)).toBeVisible();
  await expect(row.getByText("Requests you already approved are not affected.")).toBeVisible();
  await row.getByRole("group").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText(`${name} is disconnected`)).toBeVisible();
  expect((await refresh(clientId, t2.body["refresh_token"] as string)).status).toBe(400);
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name })).toHaveCount(0);
});

test("Scenario: Consent declined: access_denied, no code", async ({ page }) => {
  const reg = await registerClient(`E2E declined ${Date.now()}`);
  const clientId = reg.body["client_id"] as string;
  const redirected = await catchRedirect(page);
  await page.goto(authorizeUrl(clientId, pkce().challenge));
  await signIn(page, EMAIL_2);
  await expect(page).toHaveURL(/\/consent\?/);
  await page.getByRole("button", { name: "Don't connect" }).click();
  const back = await redirected();
  expect(back.searchParams.get("error")).toBe("access_denied");
  expect(back.searchParams.get("code")).toBeNull();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.goto("/account/clients");
  await expect(page.getByText("No apps are connected")).toBeVisible();
});
