# Spike: sign-in through an identity provider (m2-org-sign-in task 2.1, issue #127)

Throwaway, except `keycloak/` (reusable by tasks 7.1 and 7.2). Report: `openspec/changes/m2-org-sign-in/notes/spike.md`.

- `keycloak/a2h-test-realm.json`: realm `a2h-test`, client `a2h-test`, four invented users (verified, unverified, no email, a second subject with the verified user's address).
- `keycloak/start.sh`: starts the pinned image with the realm imported on a random 127.0.0.1 port; prints `KEYCLOAK_URL` and `KEYCLOAK_CONTAINER`. Stop with `docker rm -f -v <name>`.
- `keycloak/keycloak.ts`: `startKeycloak()` (or `A2H_KEYCLOAK_URL` for one already running), the users, and `ProviderBrowser` (posts Keycloak's login form, keeps its cookies).
- `spike-auth.ts`: the app's Better Auth configuration plus `genericOAuth` and switches for each decision. Throwaway.
- `idp.spike.ts`: the nine tests. Throwaway.

Run from `apps/web` (Docker needed; builds of the workspace packages first):

    pnpm --filter "@a2h/web^..." run build
    A2H_SPIKE_EVIDENCE=/path/to/evidence.txt pnpm exec vitest run --config test/idp-spike/vitest.spike.config.ts

Not part of `pnpm test` (the file is `*.spike.ts`).
