# Security model

What is enforced, where, and how it is tested.

| Concern | Control | Where | Tests |
|---|---|---|---|
| Provider keys in the browser | Keys exist only in the server environment and inside adapters; browser code never names them; `VITE_` secrets are ignored; legacy browser-stored keys are removed at startup | `providers/credentials`, `client/settings/settingsStore.js` | `architecture.test.mjs`, `server.test.mjs`, `remote.test.mjs` |
| Keys in records/logs/events | Sessions are scrubbed before storage (secret-named fields, `sk-…`/bearer patterns); errors are redacted; logs carry codes and ids, not prompts or sources | `persistence/serializer.js`, `utils/redact.js` | `persistence.test.mjs`, `persistence.integration.test.mjs` |
| Authentication | Bearer token on every route but health; Firebase ID tokens verified server-side (RS256, issuer, audience, expiry); `none` mode refuses non-loopback binding | `server/auth.js`, `server/config.js` | `server.test.mjs` |
| Session/workspace ownership | One runtime per user; storage paths are `users/{uid}/…`; foreign ids are "not found" on every route including the stream | `server/service.js`, `persistence/docStore.js` | `server.test.mjs` |
| Workspace confinement | Normalized relative paths; traversal, absolute paths and escaping symlinks rejected; `.git` never written; `allowedRoots` limit which folders can be opened | `workspace/pathSafety.js`, `workspaceManager.js` | `pathSafety.test.mjs`, `security.test.mjs` |
| Shell safety | Conservative classification before execution; prohibited commands never run in any mode; secrets stripped from the environment; own process group, timeout, cancellation, output cap | `tools/permissions.js`, `workspace/shell.js` | `permissions.test.mjs`, `security.test.mjs` |
| Permission modes | Ask / Auto Edit / Full Auto map effects to allow/ask/block; Full Auto still asks for external effects and blocks prohibited; unknown effects fail closed | `tools/permissionModes.js` | `permissions.test.mjs`, `security.test.mjs` |
| Output injection | Markdown has no raw HTML; diffs and command output render as text with terminal escapes removed | `client/chat/markdown.js`, `client/workspace/terminalText.js` | `markdown.test.mjs`, `workspace.test.mjs` |
| Git restore | Single-file, user-confirmed; never resets/cleans; refuses `.git` and escaping paths; not available to the model | `workspace/git.js`, `agent/runtime.js` | `workspaceReview.test.mjs` |
| Network exposure | Environment validated at startup; `none` auth only on loopback; production requires auth and workspace roots; CORS grants exactly one configured origin (wildcards refused); `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` on API responses | `server/config.js`, `server/http.js` | `stabilization.test.mjs` |
| Abuse limits | Request bodies over 1 MB → 413; per-user caps on live conversations and concurrent runs → 429; JSON request and header timeouts | `server/http.js`, `server/service.js`, `server/main.js` | `stabilization.test.mjs`, `reliability.test.mjs` |
| Diagnostics | `/api/health` and `/api/ready` expose versions and categories only; request logs hold no bodies, tokens, query strings or full session ids; errors carry a request id, never a stack | `server/http.js`, `server/doctor.js`, `client/runtime` | `reliability.test.mjs`, `doctor.test.mjs`, `connection.test.mjs` |
| Dependency direction | Providers cannot reach tools/workspaces; the browser cannot import the runtime, Node built-ins or credential modules | — | `architecture.test.mjs` |

## Operating guidance

- Never send bearer tokens over plain public HTTP: terminate TLS in front of the runtime. See [DEPLOYMENT.md](DEPLOYMENT.md).
- Run behind HTTPS with `BLUSWAN_AUTH=firebase`, `BLUSWAN_WORKSPACE_ROOTS` set, and `BLUSWAN_PERSISTENCE=firebase` or a persistent `BLUSWAN_DATA_DIR`.
- With `NODE_ENV=production` the server refuses to start without authentication (unless `BLUSWAN_ALLOW_NO_AUTH=1`) and requires `BLUSWAN_WORKSPACE_ROOTS`.
- `BLUSWAN_AUTH=none` is for a single developer on loopback; it grants the caller command execution on the host (within permission modes).
- Session records may contain repository contents and command output. `firestore.rules` denies direct client access to them.
- The agent can run commands in the repositories you open. Prefer Ask or Auto Edit mode for unfamiliar code and review the diff before committing.

## Known limits

- No per-user provider keys, per-IP rate limiting, or multi-instance coordination (one process owns a user's live runs). Only per-user caps exist.
- Command classification is heuristic: it is deliberately conservative, but it is not a sandbox. Use OS-level isolation (container, VM, unprivileged user) for untrusted code.
- `npm audit` reports advisories in development tooling; they do not ship in the runtime.
