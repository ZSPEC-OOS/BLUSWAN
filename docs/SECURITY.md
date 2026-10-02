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
| GitHub credentials | GitHub App installation tokens are minted and held in server memory; Git gets them as a host-scoped header in the child environment only; never in argv, `.git/config`, storage, responses, events or logs; all GitHub text is scrubbed (`redactGithub`) | `server/github/*` | `github.test.mjs`, `architecture.test.mjs` |
| GitHub connection integrity | Signed, expiring, single-use connect state bound to the signed-in user; the GitHub user's authorization code proves installation ownership; webhooks need a valid constant-time HMAC | `server/github/feature.js` | `github.test.mjs` |
| Clone and Git safety | Owner/repo validated, opaque per-user directories, `realpath` containment, atomic partial-clone directory; hooks disabled, `ext::` transports blocked, argv only, branch names validated; no force/hard flags; default branch protected; origin must match; sensitive files never staged | `server/github/paths.js`, `gitRunner.js`, `feature.js` | `github.test.mjs`, `architecture.test.mjs` |
| Dependency direction | Providers cannot reach tools/workspaces; the browser cannot import the runtime, Node built-ins or credential modules | — | `architecture.test.mjs` |

## GitHub workflow security review (Phase 11)

| Risk | Outcome |
|---|---|
| Token exposure | Tokens exist only in server memory and a child process environment; asserted absent from `.git/config`, persisted data, API responses and SSE; browser code has no token handling or browser storage in `client/github` (architecture test). |
| Command injection | `execFile` with argv, no shell; branch names rejected if option-shaped or invalid; clone uses `--`; paths staged with literal pathspecs; commit message is a single argument. |
| Repository-controlled code | Hooks disabled for every server git call; `protocol.ext.allow=never`; clone URL must be `https://<github-host>/<owner>/<repo>.git`. |
| Path traversal / arbitrary clone location | Names validated, destination computed (never supplied), realpath-checked under the first workspace root; deletion only inside the user's own `users/<key>/github`. |
| Cross-user access | Workspaces, repository records and task records are per-user; foreign workspace ids are `not found` for every endpoint; separate clone directories per user. |
| Remote manipulation | `origin` is verified before push/sync/cleanup and never rewritten. |
| Unsafe deletion | Cleanup requires a verified merge, clean tree, merge commit present; `-d` first; `-D` only with a separate confirmation and only if the tip equals what GitHub merged; remote deletion only for the task's own branch. |
| Force push | Not implemented. |
| Webhook spoofing | Unsigned or mis-signed payloads → 401; endpoint absent unless a secret is set. |
| OAuth callback swapping / replay | State bound to the BLUSWAN user, 15-minute expiry, single use, verified with a code exchange and `GET /user/installations`. |
| Secrets in logs | Operation logs carry operation, repository, hashed user, duration, result only; errors pass through `redactGithub`. |
| Residual risk | An installation token is visible to same-user processes in the environment of a running git child for the duration of one command; the agent's own shell is a separate permission-gated surface and does not receive these variables. |

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
- Dependency audit (Phase 11): `npm audit fix` (non-breaking) and a patch bump of Vite (7.3.1 → 7.3.6, dev-server advisories) cleared the critical and the development-tooling findings. What remains is `@grpc/grpc-js` ≤ 1.13.5 (4 high, 1 low) reached only through the `firebase` web SDK's Firestore client. BLUSWAN's browser bundle imports only `firebase/app` and `firebase/auth` (no Firestore, no gRPC), and the server persists to Firestore through the optional `firebase-admin` package, which is not a dependency of this repository. The advisories concern gRPC *servers* and client TLS auth contexts, neither of which BLUSWAN runs. The available fix is `npm audit fix --force` (a Firebase major change), deliberately not applied here; revisit on the next Firebase upgrade.
