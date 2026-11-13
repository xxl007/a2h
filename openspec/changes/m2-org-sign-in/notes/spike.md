# Spike: sign-in through an identity provider (task 2.1, issue #127)

Run 2026-11-13 on branch `spike/m2-org-sign-in` (base `cf64fc5`, origin/main). Throwaway except the Keycloak helper.

## What was run

- Keycloak `quay.io/keycloak/keycloak:26.8.2@sha256:723b1d6e…75e41` (pinned by digest), `start-dev --import-realm`, realm `a2h-test` with invented users only: `verified` (verified email), `unverified` (email, `emailVerified: false`), `noemail` (no email), `reassigned` (another subject carrying `verified`'s address). Client `a2h-test`, confidential, PKCE S256, one redirect address `http://localhost:3000/api/auth/callback/idp`.
- Postgres 17 container from `apps/web/test/lib/global-setup.ts`, one schema per test with the repo's migrations, plus `user.last_idp_sign_in_at` added by hand (the real migration is task 3.2).
- Better Auth 1.7.14 in process: the app's configuration (jwt, mcp, cimd plugins, `customTokenResponseFields`) plus `genericOAuth` with provider id `idp` (discovery URL, `requireIdTokenVerification: true`, `pkce: true`, scopes `openid email profile`, `overrideUserInfo: true`). Driven over its HTTP handler, as `apps/web`'s own auth tests do (`test/lib/auth-harness.ts`); Keycloak's login form is posted by a scripted browser (real HTTP, real cookies). Not a `next dev` server: the handler is the same code the route mounts, and no page was needed.
- Each point has a control run with the relevant option switched off, to show the test can fail.

Commands (from `apps/web`, Node 22):

    pnpm --filter "@a2h/web^..." run build
    A2H_SPIKE_EVIDENCE=<file> pnpm exec vitest run --config test/idp-spike/vitest.spike.config.ts

Result: `Test Files 1 passed (1) · Tests 9 passed (9) · Duration 81.13s`. The `EVIDENCE` lines below are copied from that run, trimmed.

Context7 was not available (its API key is refused), so no library question was answered from documentation; every claim below is from the run.

## Results

### 1. Callback path and a full sign-in — holds (D1)

    EVIDENCE 1 {"authorize":{"redirect_uri":"http://localhost:3000/api/auth/callback/idp","response_type":"code","scope":"openid email profile","code_challenge_method":"S256","has_state":true,"has_nonce":true},
      "callback":{"path":"/api/auth/callback/idp","params":["code","iss","session_state","state"]},
      "appAnswer":{"status":302,"location":"/account/clients"},
      "rowsBefore":{"users":0,"accounts":0,"sessions":0},"rowsAfter":{"users":1,"accounts":1,"sessions":1},
      "account":{"provider_id":"idp","account_id_is_uuid":true},
      "user":{"email":"verified.person@a2h-test.example","email_verified":true,"name":"Vera Verified"},
      "getSessionUserMatches":true,"keycloakOnOtherRedirectUri":400}
    EVIDENCE 1-replay {"status":302,"location":"http://localhost:3000/sign-in?error=state_mismatch","rows":{"users":1,"accounts":1,"sessions":1}}

The subject (Keycloak's user UUID) is `account.account_id`. Replaying the same callback URL is refused (`state_mismatch`) and writes nothing. Internally the route is the core `/callback/:id` with `id = idp` (relevant to point 4).

### 2. Refusal before any write, with its own code — holds (D3), with a correction

    EVIDENCE 2 {"unverified":{"status":302,"location":"/sign-in?error=email_not_verified&error_description=…","rows":{"users":0,"accounts":0,"sessions":0},"sessionCookie":false,"getSession":null},
      "noemail":{"status":302,"location":"/sign-in?error=email_not_found","rows":{"users":0,"accounts":0,"sessions":0},"getSession":null},
      "validateUserInfoCalls":[{"action":"create-user","method":"oauth","providerId":"idp","path":"/callback/:id", …}],"verificationRowsLeft":0}
    EVIDENCE 2-control-no-validateUserInfo {"location":"/account/clients","rows":{"users":1,"accounts":1,"sessions":1}}
    EVIDENCE 2-returning-refused {"location":"/sign-in?error=email_not_verified…","rows":{"users":1,"accounts":1,"sessions":1},"actions":["create-user","sign-in"],"sessionsOfUser":1}

- Unverified: refused by `validateUserInfo` returning `{ error: "email_not_verified" }`; the code reaches the sign-in page as `?error=`. No user, account or session; the control without the hook lets the person in.
- No email: refused by the library itself with `email_not_found`, before `validateUserInfo` is called (one call only, for the unverified user). The code is distinct, but it is the library's, not ours.
- A returning person is also checked (`action: "sign-in"`), so the access-removed refusal of D7 can live in the same hook; no new session was written.
- `validateUserInfo` sees the ID-token claims (`email_verified`, `sub`, `iss`, …), so the configurable claim name of D3 works for a claim present in the ID token.

### 3. Provider tokens kept out of `account` — holds (D5), needs two hooks

    EVIDENCE 3 {"controlWithoutHook":{"access_token":true,"refresh_token":true,"id_token":true,"access_token_expires_at":true,…},
      "withHook_firstSignIn":{"access_token":false,"refresh_token":false,"id_token":false,"access_token_expires_at":false,"refresh_token_expires_at":false,"scope":"openid,email,profile"},
      "withHook_returningSignIn":{ same, all false },
      "hookSaw":[{"hook":"account.create.before","hadIdToken":true,"hadAccessToken":true,"hadRefreshToken":true},
                 {"hook":"account.update.before","keys":["accessToken","accessTokenExpiresAt","idToken","providerId","refreshToken"]}]}

A returning sign-in rewrites the tokens through `account.update`, so the hook must be on both `databaseHooks.account.create.before` and `account.update.before`. `scope` stays (harmless).

### 4. Hook for `last_idp_sign_in_at` — both candidates hold; use the `after` hook (D6)

    EVIDENCE 4-after-hook {"first":{"to":"/account/clients","written":true},"returning":{"laterThanFirstByMs":1280},
      "refusedCallbackOfAnotherPerson":{"to":"/sign-in?error=email_not_verified…","unchanged":true},
      "hookEvents":[{"hook":"session.create.after","path":"/callback/:id","params":{"id":"idp"}},
                    {"hook":"after:/callback/:id","params":{"id":"idp"},"newSessionUserId":"<user id>","returnedIsError":true,"returnedStatus":"FOUND"}, …,
                    {"hook":"after:/callback/:id","params":{"id":"idp"},"newSessionUserId":null,"returnedIsError":true,"returnedStatus":"FOUND"}]}
    EVIDENCE 4-session-db-hook { same outcome: first written, returning later by 1466 ms, refusal unchanged }

- A plugin `hooks.after` with matcher `ctx.path === "/callback/:id"`, writing when `ctx.context.newSession` is set and `ctx.params.id === "idp"`: writes on first and returning sign-ins, not on a refusal (`newSession` is null). Note: the success itself arrives as a thrown 302 (`returned` is an `APIError` with status `FOUND`), so the hook must not treat an error in `returned` as failure.
- Fallback that also works: `databaseHooks.session.create.after` with `ctx.path === "/callback/:id"` and `ctx.params.id === "idp"`.
- Recommendation: the `after` hook (it runs only once a session exists for that callback and reads no path-specific context in a database hook).

### 5. `/sign-in/social` over HTTP disabled, server action still starts the redirect — holds (D2)

    EVIDENCE 5 {"disabled":{"redirectBranch":404,"idTokenBranch":404,"body":"Not Found"},
      "serverAction":{"host":true,"path":"/realms/a2h-test/protocol/openid-connect/auth","stateCookieSet":["better-auth.state"]},
      "controlPathOpen":{"redirectBranch":200,"returnsAuthorizeUrl":true,"idTokenBranch":401,"idTokenBranchBody":"{\"message\":\"Invalid token\",\"code\":\"INVALID_TOKEN\"}"}}

With `disabledPaths: [..., "/sign-in/social"]` both branches (redirect and raw ID token) answer 404. `auth.api.signInSocial({ body: { provider: "idp", … }, returnHeaders: true })` still returns the provider's authorize URL and the `better-auth.state` cookie, which the server action must forward to the browser; the test then completes a sign-in from it. The control shows the ID-token branch is live when the path is open (401 on a junk token, i.e. it tries to verify).

### 6. Session ends at 12 h, no sliding — holds with a global setting; does not hold "per method" as written (D6)

Clock moved with fake `Date` after sign-in; the session read at +6 h, +11 h 59 min, +12 h 01 min.

    EVIDENCE 6-global {"atCreation":"…T10:37:03Z","reads":{"+6h":{"signedIn":true,"storedExpiry":"…T10:37:03Z"},"+11h59m":{"signedIn":true,"storedExpiry":"…T10:37:03Z"},"+12h01m":{"signedIn":false}}}
    EVIDENCE 6-hook-norefresh { same as global }
    EVIDENCE 6-hook {"atCreation":"2026-11-14T10:37:05Z","reads":{"+6h":{"storedExpiry":"2026-11-21T04:37:05Z"},…,"+12h01m":{"signedIn":true}}}
    EVIDENCE 6-sliding-control {"+6h":{"storedExpiry":"…T16:37:05Z"},"+11h59m":{"storedExpiry":"…T22:36:05Z"},"+12h01m":{"signedIn":true}}
    EVIDENCE 6-stored-expiry-moved {"before":true,"after":null}

- `global` (`session: { expiresIn: 43200, disableSessionRefresh: true }`): holds; expiry never moves, signed out after 12 h.
- `hook-norefresh` (library default lifetime, `disableSessionRefresh: true`, a `session.create.before` hook that sets 12 h on `/callback/:id`): holds for provider sessions, but magic-link sessions then last 7 days without sliding, which is not "today's lifetime" (today is the library default, 7 days sliding).
- `hook` (12 h cap at creation, refresh left on): does not hold. The first read renews the session to now + 7 days, because the library derives the session's age from `expiresAt - expiresIn`.
- `sliding-control` shows the test detects sliding.

Conclusion: "12 h without sliding for provider sessions while magic-link sessions keep today's lifetime" cannot be had; session refresh is a single global switch.

6b (extra): a second sign-in with Keycloak's own session still alive comes back without the password form (`formShown: false`) and creates a session, so it also stamps `last_idp_sign_in_at`. The renewal window measures "last successful callback", which the provider's own session policy can satisfy silently.

### 7. Implicit linking disabled: new subject with an existing address refused — holds (D4), refused by the library, not by `validateUserInfo`

    EVIDENCE 7 {"refused":{"location":"/sign-in?error=account_not_linked","rowsBefore":{"users":1,"accounts":1,"sessions":1},"rowsAfter":{ same },"getSession":null,"subjectUnchanged":true},
      "validateUserInfoActions":["create-user"],
      "controlLinkingAsTheLibraryDoes":{"location":"/account/clients","rows":{"users":1,"accounts":2,"sessions":2},"validateUserInfoActions":["create-user","link-account"]}}

With `account.accountLinking.disableImplicitLinking: true` the second subject is refused with the library's code `account_not_linked` and `validateUserInfo` is not called for it. The control (linking as the library does) links the reassigned subject to the first person's user and signs them in as that person: the risk D4 names, reproduced.

### 8. `invalid_grant` from `customTokenResponseFields` leaves the refresh token usable — holds (D6)

Full agent connection: dynamic registration, authorize, sign-in page, Keycloak, callback, authorize, consent (with a per-transaction instance built without the provider plugin, D8), code exchange. Then `last_idp_sign_in_at` set 8 days back.

    EVIDENCE 8 {"issued":{"status":200,"hasRefreshToken":true},
      "staleRefresh":{"status":400,"body":{"error":"invalid_grant","error_description":"the principal must sign in at the identity provider again"}},
      "staleRefreshSecondAttempt":400,
      "familyAtIssue":[{"revoked":false,"rotated":false}],"familyAfterRefusal":[{"revoked":false,"rotated":false}],
      "sameTokenAfterNewSignIn":{"status":200,"hasAccessToken":true,"rotated":true},
      "familyAfterRenewal":[{"revoked":true,"rotated":true},{"revoked":false,"rotated":false}]}

The refusal neither rotates nor revokes; after a new provider sign-in the very same refresh token is accepted and rotated normally.

## What design.md must change

1. **D3**: two of its three refusals are not decided by `validateUserInfo`. "No email address" is refused by the library first (`email_not_found`); "an email address another account already has" is refused by the library when implicit linking is off (`account_not_linked`). `validateUserInfo` decides "not verified" (our code, e.g. `email_not_verified`) and "access removed" (works for returning people, `action: "sign-in"`). The page must map all four codes, two of them the library's.
2. **D5**: strip tokens in both `account.create.before` and `account.update.before` (returning sign-ins rewrite them).
3. **D6 session**: choose one, since sliding cannot be turned off per method. Recommended: `expiresIn` 43200 and `disableSessionRefresh` for every session (magic-link sessions on dev and previews become 12 h too). Alternative: `disableSessionRefresh` globally plus a `session.create.before` hook giving provider sessions 12 h, magic-link sessions 7 days fixed. A 12 h cap with refresh left on does not work.
4. **D6 timestamp**: the hook is a plugin `hooks.after` on `/callback/:id` reading `ctx.context.newSession` (fallback: `databaseHooks.session.create.after` on the same path). Open question closed. Add a sentence that a silent provider SSO counts as a sign-in for the renewal window.
5. **D2**: the server action must forward the `better-auth.state` cookie returned by `signInSocial(..., returnHeaders: true)`.

## Not run

- A real `next dev`/`next start` server and the real server action (the in-process handler and `auth.api` were used instead).
- Any provider other than Keycloak; Entra's `xms_edov` claim; a claim present only in userinfo and not in the ID token.
- Forged tokens (wrong key, issuer, audience, expiry): left to the fake issuer of task 7.1.
- How MCP clients react to `invalid_grant` (task 7.4).

## Reusable pieces

`apps/web/test/idp-spike/keycloak/`: `a2h-test-realm.json` (realm, client, four invented users), `start.sh` (pinned image, random 127.0.0.1 port, prints `KEYCLOAK_URL` and `KEYCLOAK_CONTAINER`), `keycloak.ts` (`startKeycloak()`, `USERS`, `ProviderBrowser` that posts Keycloak's login form). For tasks 7.1 and 7.2; move to `tests/` or `apps/web/test/lib/` when adopted. `spike-auth.ts`, `idp.spike.ts` and `vitest.spike.config.ts` are throwaway (kept on this branch only as the record of what was run).
