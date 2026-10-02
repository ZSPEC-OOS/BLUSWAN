# Development

## Setup

```bash
npm install
cp .env.example .env      # set the provider(s) you use (the template holds variable names only)
npm run server            # runtime + API on http://127.0.0.1:8787 (loads .env if present)
npm run dev               # web app on http://localhost:5173, /api proxied to the server
```

Node 22+. `server`, `agent`, `eval` and the live smoke scripts load `.env` when it exists (`--env-file-if-exists`); in
production set the variables in the process environment instead. See [PROVIDERS.md](PROVIDERS.md) for provider variables and the
README for server options (`BLUSWAN_AUTH`, `BLUSWAN_PERSISTENCE`, `BLUSWAN_WORKSPACE_ROOTS`, …).

Run the agent from a terminal without the web app: `npm run agent -- --workspace ../my-repo "Fix the failing parser test"`
(`--provider anthropic --model <id>` to choose another provider).

## Tests

All normal tests are deterministic and offline (scripted models or mocked network). `npm test` runs everything under `src/**.test.mjs`.

| Script | Covers |
|---|---|
| `npm test` | Everything below |
| `npm run test:providers` | Adapter contract suite (all four providers via native wire formats), wire details, cross-provider runtime scenario |
| `npm run test:agent` | Agent loop, permissions, completion/recovery, integration scenarios |
| `npm run test:context` / `test:tools` / `test:workspace` / `test:validation` | Those modules |
| `npm run test:persistence` | Persistence contract on every backend, serializer, migrations, autosave, hydration, workspace reconciliation |
| `npm run test:server` | HTTP/SSE server and browser↔server end to end |
| `npm run test:client` | Client store, event projection, components (server-rendered), workspace review |
| `npm run test:architecture` | Dependency directions, legacy-import guards, secret guards |
| `npm run test:eval` | The evaluation harness itself |
| `npm run test:e2e` | Browser suite (Playwright/Chromium): real runtime + built web app, scripted model, temporary repo and storage; desktop and phone viewports |
| `npm run test:release` | `npm test` + lint + build + `test:e2e` — what CI runs |
| `npm run doctor` | Deployment diagnostics (not a test; see DEPLOYMENT.md) |
| `npm run lint`, `npm run build` | ESLint, production bundle |

Component tests render React to static markup through a small module loader (`src/client/testing`), so no DOM library is needed.

### Optional: live provider checks (not run by `npm test`)

```bash
npm run test:deepseek | test:kimi | test:openai | test:anthropic    # one trivial task per provider; needs <NAME>_API_KEY + <NAME>_MODEL
npm run eval -- --provider openai [--task fix-bug] [--json]          # fixture tasks, raw metrics
```

The evaluation harness (`src/eval`) runs fixture tasks — fix a bug, add a test, rename across files, multi-file change,
recover from a failing test — in disposable repositories and reports, per task: success (an objective check, not the
model's claim), validation status, turns, tool calls, duplicate calls, files changed and unnecessary files changed,
tokens and duration. It reports raw numbers and does not rank providers.

### Dogfooding

`npm run dogfood` has BLUSWAN repair a seeded defect in a disposable worktree of its own repository (scripted model by default; `-- --provider <id>` for a real one).
The checkout you run it from is never modified and nothing is pushed. See [DOGFOODING.md](DOGFOODING.md); raw provider baselines live in [BASELINES.md](BASELINES.md).

## Conventions

- New behaviour that varies by model goes behind a **capability**, never a provider name (guarded by `architecture.test.mjs`).
- Anything the model could do to a repository goes through a tool, the workspace and the permission classifier.
- Secrets are read in `src/providers/credentials` and used in `src/providers/*` only.
- Persisted data is provider-neutral; change its layout only with a `schemaVersion` bump and a migration.
