# Tasks: ci-preview-verify

Owner: QA. One PR, `chore(ci): verify previews and dev after deploy, retry transient deploy failures`, linking this folder and issue #12. Each task: failing test first, then the change, then the test green.

| # | Task | Test | Acceptance |
|---|---|---|---|
| 1 | Structural tests in `tests/ci/workflows.test.mjs` for the three added requirements | the new tests fail on the current workflows | tests name: a `verify` job in preview.yml needing `deploy` and gated on a "deployed" output; a `verify` job in deploy.yml needing `deploy`; a deploy step in both files that runs `sst deploy` twice on failure |
| 2 | `preview.yml`: deploy job exposes `deployed`, `web`, `mcp` outputs; `verify` job (checkout, pnpm, node, install, Playwright Chromium with deps) runs `tests/ci/preview-smoke.sh <alb-host> <n>`, `pnpm --filter @a2h/tests contract` with `A2H_MCP_URL`, `pnpm --filter @a2h/tests e2e` with `A2H_WEB_URL`/`A2H_MCP_URL`; uploads `tests/playwright-report` on failure; appends a "Verification" line to the sticky comment (header `a2h-preview`, `append: true`) with outcome and run link | task 1 tests; actionlint; shellcheck `-S style` on run blocks | verify runs only when `deployed == 'true'`; no `id-token` permission on verify (it only reads public URLs) |
| 3 | `deploy.yml`: same `verify` job against `dev` (`A2H_STAGE=dev`, MCP `http://<alb>/mcp`); smoke uses the dev health path | task 1 tests; actionlint | Deploy workflow red when any suite fails |
| 4 | Retry: in both deploy steps, `sst deploy` once more after a pause on failure; check SST 4 docs (sst.dev/docs/reference/cli) for `sst unlock` and whether a failed deploy leaves the lock; unlock before the retry only if needed | task 1 tests | the step's exit code is the second attempt's |
| 5 | `tests/README.md`: contract and e2e "run in CI on every preview and on dev; the idle scenario stays opt-in" | n/a | README matches the workflows |
| 6 | Validation run: `pnpm lint`, `pnpm typecheck`, `node --test tests/ci/*.test.mjs`, actionlint on `.github/workflows/*.yml`, shellcheck `-S style`; then open the PR and let its own preview run the new `verify` job | all green locally; `verify pr-<n>` green on the PR | PR body has "How to validate" for the owner with the run link |

## Checklist

- [ ] 1 structural tests (red first)
- [ ] 2 preview.yml verify job + comment line
- [ ] 3 deploy.yml verify job
- [ ] 4 deploy retry
- [ ] 5 README
- [ ] 6 validation + PR
