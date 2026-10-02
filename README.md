# BLUSWAN

A chat-first autonomous coding agent. Describe a change; BLUSWAN reads and edits your repository through safe tools,
runs your project's own tests, lint and build, repairs what fails, and shows you exactly what changed — with a diff,
the commands it ran, and a one-click way to undo any file.

- **Sessions** — conversations that persist, reload, and continue; a run interrupted by a restart is shown as such, never silently resumed.
- **Workspace tools** — read, search, patch, write, run commands, inspect git — all confined to the repository you open.
- **Context management** — long sessions stay within the model's window through deterministic summaries and compaction.
- **Validation** — the project's own checks decide whether the change works, not the model's say-so.
- **Diff review** — authoritative git-backed changed files, per-file unified diffs, command output, validation details, single-file revert.
- **Permissions** — Ask / Auto Edit / Full Auto; destructive or external actions pause for your approval; unsafe commands never run.
- **Persistence** — file, Firestore or in-memory storage behind one interface.
- **Multiple providers** — DeepSeek, Kimi, OpenAI and Anthropic through one provider-neutral runtime. You choose the model; BLUSWAN does not route or fall back on its own.

## Quick start

```bash
npm install
cp .env.example .env     # add the key + model for the provider(s) you use
npm run server           # runtime, credentials and storage: http://127.0.0.1:8787
npm run dev              # web app: http://localhost:5173
```

Check the setup any time with `npm run doctor`. Open a repository from **Settings → Repository**, start a chat, and ask for a change. Provider keys live only in the
server's environment; the browser is only told whether a provider is configured.

From a terminal instead: `npm run agent -- --workspace ../my-repo "Fix the failing parser test"`.

## Configuration

| Variable | Purpose |
|---|---|
| `DEEPSEEK_*`, `KIMI_*`, `OPENAI_*`, `ANTHROPIC_*` | `_API_KEY`, `_MODEL`, `_BASE_URL` per provider ([docs/PROVIDERS.md](docs/PROVIDERS.md)) |
| `BLUSWAN_AUTH` | `none` (one local user, loopback only) or `firebase` (verify Firebase ID tokens; needs `FIREBASE_PROJECT_ID`) |
| `BLUSWAN_PERSISTENCE`, `BLUSWAN_DATA_DIR` | `file` (default, `.bluswan/data`), `memory`, or `firebase` (Firestore via `firebase-admin`) |
| `BLUSWAN_WORKSPACE_ROOTS` | Folders repositories may be opened under (required with authentication) |
| `BLUSWAN_PORT`, `BLUSWAN_HOST` | Listen address (default `127.0.0.1:8787`) |
| `BLUSWAN_CORS_ORIGIN` | Split-origin only: the one web origin allowed to call the runtime |
| `BLUSWAN_MAX_TURNS`, `BLUSWAN_REQUEST_TIMEOUT_MS`, … | Server-owned agent tuning (formerly `VITE_BLUSWAN_*`, which no longer has any effect) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG` (+ optional `GITHUB_APP_WEBHOOK_SECRET`) | GitHub App for the repository workflow; all or none ([docs/GITHUB.md](docs/GITHUB.md)) |
| `VITE_BLUSWAN_API_URL` | Web build only: the runtime's absolute URL for split-origin deployments (unset = same origin) |

`.env.example` lists every variable by name. The runtime validates its environment at startup and reports every problem at once.
Secrets must never be prefixed with `VITE_`.

## Deployment

BLUSWAN is a **runtime** (agent, provider keys, storage, your repositories) plus a **web app** that talks to it. A static host alone is not enough.

```text
Mode A (local)    browser ─ Vite proxy ─► runtime 127.0.0.1:8787            one user, no sign-in, loopback only
Mode B (remote)   browser ─ HTTPS ─► reverse proxy ─ /api ─► runtime        Firebase auth, workspace roots, persistent storage
                                       └─ static dist/
```

Remote runtimes need `NODE_ENV=production`, `BLUSWAN_HOST=0.0.0.0`, `BLUSWAN_AUTH=firebase`, `FIREBASE_PROJECT_ID`, `BLUSWAN_WORKSPACE_ROOTS` and HTTPS.
Same-origin behind one proxy is recommended; split-origin needs `VITE_BLUSWAN_API_URL` + `BLUSWAN_CORS_ORIGIN`. The runtime must run on the machine that owns the repositories.
Liveness is `GET /api/health`, readiness is `GET /api/ready`. Full guide with nginx/Caddy examples, mobile guidance and operating notes: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
When something does not connect: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) and `npm run doctor`.

## GitHub workflow (optional)

Connect a GitHub App and the whole task lifecycle runs from the UI, desktop or phone: browse repositories, **Clone & Open**, **Create Task Branch**, let BLUSWAN code,
**Commit**, **Push**, **Create Pull Request**, merge on GitHub, then **Sync Main & Clean Up** and start the next task. GitHub credentials never reach the browser; nothing is merged
or force-pushed for you. Without GitHub configuration BLUSWAN works exactly as before with local repositories. Setup, minimum permissions and Render notes: [`docs/GITHUB.md`](docs/GITHUB.md).

## Scripts

| Script | |
|---|---|
| `npm run server` / `dev` / `build` | Run the server, the web app, a production build |
| `npm run agent` | Run the agent from the terminal against a local repository |
| `npm test` | All offline tests (deterministic; no network, no live providers) |
| `npm run lint` | ESLint |
| `npm run doctor` | Checks environment, runtime, readiness, storage, workspace roots, event stream and CORS (`-- --url …`, `-- --live` for opt-in billable provider checks) |
| `npm run dogfood` | BLUSWAN repairs a seeded defect in a disposable worktree of its own repo; your checkout is never modified, nothing is pushed ([docs/DOGFOODING.md](docs/DOGFOODING.md)) |
| `npm run test:e2e` | Builds the app and runs the browser suite (Chromium, desktop + phone viewport) against the real runtime with a scripted model — offline, free |
| `npm run test:release` | `npm test` + lint + build + browser suite (no live providers) — the [release checklist](docs/RELEASE_CHECKLIST.md) gate |
| `npm run test:deepseek` · `test:kimi` · `test:openai` · `test:anthropic` | Optional live smoke test per provider (needs credentials) |
| `npm run eval -- --provider <id>` | Optional live coding evaluation with raw metrics |

More: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) (setup, test matrix, evaluation, dogfooding) · [`docs/GITHUB.md`](docs/GITHUB.md) · [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) · [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) · [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) · [`docs/PROVIDERS.md`](docs/PROVIDERS.md) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/SECURITY.md`](docs/SECURITY.md).

## Architecture in one picture

```text
Browser ──HTTP/SSE──► Server ─► Session Runtime ─► Context Engine
                                     ├─► Provider Registry ─► DeepSeek │ Kimi │ OpenAI │ Anthropic
                                     ├─► Tool Executor ─► Workspace ─► files · search · shell · git
                                     ├─► Validation Engine
                                     └─► Persistence (file │ Firestore │ memory)
```

One agent loop, one context engine, one tool executor, one provider abstraction, one UI. Details and invariants are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What survives a reload

Completed and idle sessions come back as they were. A session that was running or waiting for approval comes back as
**interrupted** — in-flight provider streams and commands are gone and are never replayed; work already applied stays in
the repository and is re-read from git. Changed files and validation status are reconciled with the repository as it is
now (validation turns *stale* if the code moved). If a repository is unavailable you keep the conversation and can reconnect the folder.

## Limitations

- Provider adapters pass an offline contract suite built from each service's documented wire format; they have not been run against the live services in this repository's CI. Use the live smoke tests with your own credentials.
- Server-configured provider keys only; per-user keys need a secrets service.
- Command classification is conservative but is not a sandbox — use OS-level isolation for untrusted code.
- No commit/push/PR workflow, no embedded editor or terminal, no automatic model routing.
- Long transcripts are loaded whole when a session opens.
- One runtime process owns a user's live runs; there is no multi-instance coordination.
- The browser suite stands in for Firebase sign-in with an identity-aware gateway (the emulator is not available offline); the sign-in screen itself is checked manually.

## History

BLUSWAN previously had earlier execution engines; they were removed. Their documents are kept under `docs/history/` and `docs/adr/` for reference only.
