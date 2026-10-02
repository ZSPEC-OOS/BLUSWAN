# Troubleshooting

Start with `npm run doctor` (see [DEPLOYMENT.md](DEPLOYMENT.md)); the page's **Connection details** button runs the same stages from the
browser and shows the request id of the last failure.

| What you see | Meaning | What to do |
|---|---|---|
| **"BLUSWAN could not reach its runtime"** | Nothing BLUSWAN-shaped answered at the API address: the runtime is stopped, the port/host is wrong, a proxy returned 502/503/504, or the URL is wrong. | Start `npm run server`; check `BLUSWAN_PORT`; for remote setups check the reverse proxy routes `/api/` to the runtime. The page retries by itself (0.5 s, 1 s, 2 s, 4 s, 8 s, then every 15 s) and **Try again** retries immediately. |
| **401 / "Your session has expired"** | The runtime did not accept your token. | Sign in again. If it happens right after sign-in, check `FIREBASE_PROJECT_ID` on the runtime matches the web app's Firebase project and the runtime's clock is correct. |
| **"BLUSWAN's runtime is starting…"** / readiness 503 | Up but not ready (`/api/ready`). | Read `checks` in the readiness body: `persistence: unavailable` → storage backend / `BLUSWAN_DATA_DIR` permissions / Firestore credentials; `workspaces: unavailable` → `BLUSWAN_WORKSPACE_ROOTS` does not exist on that machine. Coding is paused until it is fixed; nothing is lost. |
| **"No model provider is configured"** | The runtime has no key for the chosen provider. | Set `DEEPSEEK_API_KEY` (or another provider) **on the runtime**, restart it. The rest of BLUSWAN keeps working. |
| **"Workspace unavailable: <repo>"** | The folder was moved/deleted, or the conversation was created on another machine. | The conversation is kept. Use **Reconnect** and enter the folder's current path. The runtime must run on the machine that owns the folder. |
| **Banner "Connection lost — reconnecting…" loops** | The event stream keeps dropping. | Most often a proxy buffering or timing out SSE. Set `proxy_buffering off` and a read timeout well above 15 s for `/api/stream`; `npm run doctor` reports "event stream did not deliver data" for buffering proxies. |
| **Browser console: CORS error** | Split-origin without a matching origin. | Set `BLUSWAN_CORS_ORIGIN` to the web app's exact origin (scheme + host + port, no trailing slash) **or** use same-origin behind one proxy. Wildcards are refused on purpose. |
| **Connection screen: "this device is trying to reach a runtime at localhost"** | The app was built with `VITE_BLUSWAN_API_URL=http://localhost:…` but is opened from another device. | Rebuild with the runtime's public HTTPS URL, or use same-origin. |
| **"This page and the runtime do not match"** | Different releases: `protocolVersion` differs. | Reload; if it persists, deploy the web app and runtime from the same release. |
| **Works on the laptop, not from the phone** | Runtime bound to `127.0.0.1`, or served over plain HTTP, or the API URL says `localhost`. | `BLUSWAN_HOST=0.0.0.0` + `BLUSWAN_AUTH=firebase` behind HTTPS; doctor reports "bound to localhost only". |
| **Runtime refuses to start** | Environment validation failed. | The message lists every problem. Common: `BLUSWAN_AUTH=none` with a non-loopback host, production without auth or without `BLUSWAN_WORKSPACE_ROOTS`, `FIREBASE_PROJECT_ID` missing, port already in use. |
| **"Too many conversations / running at once" (429)** | Per-user abuse guard (500 live conversations, 8 concurrent runs). | Delete old conversations or wait for runs to finish. |
| **Offline banner but the runtime is up** | The page is showing its cached list and has not reconnected yet. | **Try now**; if it stays, open Connection details. |

| **"GitHub integration is unavailable"** | The runtime has no `GITHUB_APP_*` configuration. | Local repositories still work. To enable GitHub follow [GITHUB.md](GITHUB.md); `npm run doctor` shows what is missing. |
| **"GitHub access expired or was revoked" / `github_auth_expired`** | The installation or app credentials were rejected. | Reconnect GitHub; check the app is still installed and `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` match. |
| **`github_permission_denied` / repository missing from the list** | The app is not installed on that repository, or lacks a permission. | Install it on the repository (*Selected repositories*), grant Contents/Pull requests (read & write), then **Refresh**. |
| **`github_rate_limited`** | GitHub is throttling the app. | Wait the stated time; avoid repeated refreshes. |
| **"The working tree has uncommitted changes…"** | A branch change, sync or cleanup would lose work. | Commit the changes (or discard them yourself); BLUSWAN never stashes or resets silently. |
| **"…rejected the push because it has commits you do not have"** | The remote branch moved. | **Sync**; if it reports divergence resolve it in a terminal or on GitHub. BLUSWAN never force-pushes. |
| **"Repository remote does not match the connected GitHub repository"** | `origin` was changed on the runtime host. | Restore `origin` yourself (`git remote set-url origin …`); BLUSWAN will not rewrite it. |
| **Clones disappear after a restart** | `BLUSWAN_WORKSPACE_ROOTS` is on ephemeral storage (for example `/tmp`). | Mount a persistent disk and point `BLUSWAN_WORKSPACE_ROOTS` and `BLUSWAN_DATA_DIR` at it. |
| **Merged PR not noticed** | No webhook and the tab is hidden. | Press **Refresh Status**, or enable the webhook. |

Reading logs: every request line contains a `requestId`; the same id is returned in the `X-Request-ID` header and shown in Connection details.
