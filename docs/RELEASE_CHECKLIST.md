# Release checklist

Run from a clean checkout of the release commit. Everything below is offline except the optional live provider checks.

## Automated gate

```bash
npm ci
npm run test:release        # npm test · npm run lint · npm run build · npm run test:e2e
```

`npm test` includes the architecture guards, the server/client suites, the doctor tests and the persistence/restoration tests.
`npm run test:e2e` builds the web app and drives it in Chromium (desktop and phone viewport) against the real runtime, a scripted model,
a temporary repository and temporary storage — no network, no keys, nothing billable. In CI the browsers come from `npx playwright install --with-deps chromium`.

Individual suites: `test:providers` · `test:agent` · `test:context` · `test:tools` · `test:workspace` · `test:validation` · `test:persistence` ·
`test:server` · `test:client` · `test:architecture` · `test:eval`.

## Deployment gate

- [ ] `npm run doctor` against the target runtime: no ✕.
- [ ] `/api/health` reports the expected `version` and `protocolVersion`; `/api/ready` is 200.
- [ ] Runtime started with `NODE_ENV=production`, `BLUSWAN_AUTH=firebase`, `BLUSWAN_WORKSPACE_ROOTS`, persistent storage; the startup log shows no warnings you do not understand.
- [ ] Reverse proxy: HTTPS, `/api/` unbuffered, read timeout ≥ 1 h, `client_max_body_size` ≥ 2 MB; `doctor` reports the stream unbuffered.
- [ ] Split-origin only: `BLUSWAN_CORS_ORIGIN` is the exact web origin; doctor's CORS check passes.
- [ ] Sign in with a real account, open a repository, run one change end to end, reload, restart the runtime, confirm the conversation returns.
- [ ] Phone check (Mode B): load the page, send a message, background the tab, return — it reconnects.

## GitHub (only if enabled for this deployment)

- [ ] `npm run doctor`: `GitHub App credentials are valid`, API reachable, clone root writable, git available.
- [ ] Workspace root and data directory are on **persistent** storage (not `/tmp`).
- [ ] With a real account and a throw-away repository: Connect → Clone & Open → Create Task Branch → one change → Commit → Push → Create Pull Request → merge on GitHub → Sync Main & Clean Up → Start New Task.
- [ ] Webhook delivery shows 202 (redeliver a recent one); an unsigned request returns 401.
- [ ] The GitHub App has only the permissions in [GITHUB.md](GITHUB.md). `npm audit` reviewed.

## Optional live provider checks (billable; report each result individually)

```bash
npm run test:deepseek ; npm run test:kimi ; npm run test:openai ; npm run test:anthropic
```

Record **PASS**, **FAILED** or **NOT RUN** (no credentials) per provider. Offline contract tests do not prove live behaviour.

## Regression greps (expected: no matches in active code)

```bash
grep -rniE "core-v2|services-v2|components-v2|agentExecutor|VITE_[A-Z_]*(API_KEY|SECRET|TOKEN)" src scripts   # only the Firebase *web* key is allowed
```

## Versioning

Do not bump versions mechanically. Bump `package.json` (and `src/protocol/version.js` `APP_VERSION`, enforced equal by a test) for a release; bump
`PROTOCOL_VERSION` only for an incompatible HTTP/SSE change.

## Known limits to restate in the release notes

Command classification is not a sandbox; provider adapters are verified offline against documented wire formats unless live checks were run;
one runtime process owns a user's live runs (no multi-instance coordination); Firebase sign-in UI is exercised manually (the E2E suite uses an
identity-aware gateway stand-in).
