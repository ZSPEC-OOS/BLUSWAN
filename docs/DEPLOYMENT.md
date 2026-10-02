# Deployment

BLUSWAN has two parts that must be able to reach each other:

- the **runtime** (`npm run server`) — runs the agent, holds provider keys and storage, executes commands in your repositories;
- the **web app** (`npm run build` → `dist/`) — a static bundle that talks to the runtime over HTTP and Server-Sent Events.

A static host alone is **not** a deployment: without a runtime the app shows "BLUSWAN could not reach its runtime".
The runtime must run on **the machine that owns the repositories** — it opens folders and runs your tests there.

```text
 Mode A — local                               Mode B — remote, authenticated
 ┌─────────┐   Vite proxy   ┌─────────┐        ┌─────────┐  HTTPS  ┌──────────────┐  HTTP   ┌─────────┐
 │ browser │ ─── /api ────► │ runtime │        │ browser │ ──────► │ reverse proxy│ ──────► │ runtime │
 └─────────┘  localhost:5173└─────────┘        └─────────┘  /  /api│ (TLS, static)│ :8787   └────┬────┘
                       127.0.0.1:8787            web app + /api     └──────────────┘            repos · keys · storage
```

## Mode A — local development (one user, one machine)

```bash
npm install
cp .env.example .env        # add at least one provider key + model
npm run server              # http://127.0.0.1:8787   (BLUSWAN_AUTH=none, loopback only)
npm run dev                 # http://localhost:5173   (Vite proxies /api to the runtime)
npm run doctor              # checks all of the above
```

No sign-in, no Firebase. The runtime refuses to listen on anything but loopback in this mode.

## Mode B — remote, authenticated

Required runtime environment (names only; see `.env.example`):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `BLUSWAN_HOST` | `0.0.0.0` (or the interface your proxy reaches) |
| `BLUSWAN_AUTH` | `firebase` — authentication is mandatory off loopback; the safety check cannot be disabled by accident |
| `FIREBASE_PROJECT_ID` | your Firebase project |
| `BLUSWAN_WORKSPACE_ROOTS` | the folders repositories may be opened under (the runtime is never a general filesystem API) |
| `BLUSWAN_PERSISTENCE` | `file` with a persistent `BLUSWAN_DATA_DIR`, or `firebase` |
| provider keys | `DEEPSEEK_API_KEY` …; they stay on the runtime |

The runtime validates its environment at startup and prints **every** problem at once (bad port, unknown auth mode, Firebase without a
project id, production without workspace roots, an invalid CORS origin, …). `npm run doctor` runs the same validation plus live checks.

Build the web app with the public Firebase settings (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`,
`VITE_FIREBASE_APP_ID`). These are public by design; access control is enforced by the runtime.

**Always serve remote deployments over HTTPS.** Bearer tokens must not cross a network in plain text; the runtime warns when it sees
`http://` origins with authentication enabled, and browsers block `http` API calls from an `https` page.

### Same-origin (recommended)

The proxy serves the static app and forwards `/api` to the runtime. Leave `VITE_BLUSWAN_API_URL` unset and `BLUSWAN_CORS_ORIGIN` unset —
there is no cross-origin traffic and nothing to configure.

nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name bluswan.example.com;
  # ssl_certificate … ssl_certificate_key …

  root /srv/bluswan/dist;                       # output of `npm run build`
  location / { try_files $uri /index.html; }    # single-page app

  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Connection "";             # keep-alive to the upstream
    proxy_set_header Host $host;
    proxy_set_header X-Request-ID $request_id;  # shown in BLUSWAN's connection details
    proxy_buffering off;                        # REQUIRED: the event stream must not be buffered
    proxy_cache off;
    proxy_read_timeout 3600s;                   # the stream is long-lived; heartbeats arrive every 15 s
    proxy_send_timeout 120s;
    client_max_body_size 2m;                    # the runtime rejects bodies over 1 MB with 413
  }
}
```

Caddy:

```caddy
bluswan.example.com {
  root * /srv/bluswan/dist
  handle /api/* {
    reverse_proxy 127.0.0.1:8787 {
      flush_interval -1          # stream immediately
      transport http { read_timeout 1h }
    }
  }
  handle { try_files {path} /index.html
           file_server }
}
```

Without a proxy, the runtime can serve the built app itself: set `BLUSWAN_STATIC_DIR=/srv/bluswan/dist` (single-page fallback, immutable
caching for hashed assets, nothing outside the directory is reachable). You still want TLS in front of it.

### Split-origin

Web app on `https://app.example.com`, runtime on `https://api.example.com`:

1. build the web app with `VITE_BLUSWAN_API_URL=https://api.example.com` (absolute, no credentials, no trailing path);
2. run the runtime with `BLUSWAN_CORS_ORIGIN=https://app.example.com` — **one explicit origin**. A wildcard, a path or a non-origin value is refused at startup.

The runtime answers preflights and sends `Access-Control-Allow-Origin` only for exactly that origin; any other origin receives no CORS headers.
`Authorization` and `X-Request-ID` are allowed and `X-Request-ID` is exposed to the page.

### Phones and tablets

A phone cannot reach `localhost` on your laptop. Use Mode B (or expose Mode A through a trusted HTTPS tunnel). If a page served from a
non-local address is built with a `localhost` API URL, BLUSWAN says so on the connection screen ("this device is trying to reach a runtime
at localhost"). The repositories always live on the runtime host — the phone is only a screen and keyboard.

## GitHub integration and persistent storage (optional)

To browse, clone and open pull requests from the UI, configure a GitHub App ([GITHUB.md](GITHUB.md)). It adds `GITHUB_APP_*` variables to the runtime and
nothing to the web build. Repositories are cloned under `BLUSWAN_WORKSPACE_ROOTS`, so that location must be **durable**.

**Render example** (the same shape applies to any host with a persistent volume):

```text
Render web service (Node)            Persistent disk mounted at /var/data
  start command: npm run server        BLUSWAN_WORKSPACE_ROOTS=/var/data/repos
  NODE_ENV=production                  BLUSWAN_DATA_DIR=/var/data/bluswan
  BLUSWAN_HOST=0.0.0.0                 BLUSWAN_PERSISTENCE=file   (or firebase)
  BLUSWAN_AUTH=firebase  FIREBASE_PROJECT_ID=…
  provider keys (DEEPSEEK_API_KEY …)   GITHUB_APP_ID / _PRIVATE_KEY / _CLIENT_ID / _CLIENT_SECRET / _SLUG / _WEBHOOK_SECRET
```

A free-tier service with only `/tmp` is fine for trying BLUSWAN out; clones, unpushed commits and conversations disappear when it restarts or sleeps.
For production mount a disk (for example at `/var/data`) and point `BLUSWAN_WORKSPACE_ROOTS` and `BLUSWAN_DATA_DIR` at it — any valid path works, nothing is
hard-coded. Set the GitHub App's callback/setup URL to the web app's origin and the webhook URL to `https://<runtime>/api/github/webhook`. Ensure `git` is
installed in the image and the runtime user can write to the disk; `npm run doctor` verifies both.

## What the runtime exposes

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | Liveness: fast and safe. `{ ok, service: "bluswan", version, protocolVersion, auth }`. No paths, users or secrets. |
| `GET /api/ready` | none | Readiness: 200 when storage and workspace locations are usable, **503** with a category (`persistence_unavailable`, `workspace_host_unavailable`, `server_not_ready`) otherwise. A missing provider key does **not** make the runtime unready. |
| `POST /api/github/webhook` | HMAC signature | Optional GitHub App webhooks (only when `GITHUB_APP_WEBHOOK_SECRET` is set). |
| `GET /api/stream` | bearer | Server-Sent Events: canonical runtime events, `hello` (with `protocolVersion`) and a heartbeat every 15 s. |
| everything else under `/api` | bearer | Sessions, messages, permissions, workspaces, review. |

Every response carries `X-Request-ID` (echoed from the client if well formed). Errors never contain stack traces; the client's
"Connection details" show the request id so you can find the log line.

Use `/api/health` for liveness probes and `/api/ready` for readiness / load-balancer checks.

### Versions

`version` is the release (`package.json`); `protocolVersion` is the wire contract between page and runtime and changes only when an
incompatible change ships. The page checks it on connect and from the stream's `hello`; a mismatch stops with "This page and the runtime
do not match — Reload" instead of misbehaving.

## Operating the runtime

- **Startup log**: version, listen address, auth mode, persistence adapter, number of workspace roots and which providers are configured — no keys, no paths.
- **Request log**: one line per request (`method`, route with ids masked, status, duration, request id, abbreviated user id). No bodies, headers, tokens or query strings. `BLUSWAN_LOG_REQUESTS=0` silences it.
- **Timeouts**: JSON requests are bounded (headers 30 s, whole request 60 s); provider calls use `BLUSWAN_REQUEST_TIMEOUT_MS` / `BLUSWAN_STREAM_TIMEOUT_MS`; shell commands have their own timeouts; the event stream is capped at 6 hours per connection (the page reconnects and resyncs) and kept alive by heartbeats — keep proxy idle timeouts above 15 s (an hour is typical).
- **Limits**: request bodies over 1 MB are rejected with 413; per user at most 500 live conversations and 8 concurrent runs (429 `too_many_requests`).
- **Graceful shutdown** (`SIGINT`/`SIGTERM`): `/api/ready` flips to 503, new requests get `server_not_ready`, runs are cancelled, pending saves are flushed, workspaces and shells are released, streams are closed — within about 8 seconds. A second signal forces exit.
- **Restarts**: stored conversations return after a restart. A run that was cancelled by the shutdown shows as stopped; a run lost to a crash shows as *interrupted*. Nothing is replayed.
- **Storage**: file persistence writes atomically (temp file + rename). An unreadable record is moved aside as `<name>.corrupt-<time>` and never blocks startup.

## Checking a deployment

```bash
npm run doctor                                  # local environment + runtime at BLUSWAN_HOST:BLUSWAN_PORT
npm run doctor -- --url https://bluswan.example.com
npm run doctor -- --live                        # also one small, billable request per configured provider (opt-in)
```

It checks: environment validity, provider keys present (names only), workspace roots accessible, persistence writable, runtime reachable
and compatible, readiness, whether the event stream is delivered unbuffered, and CORS for split-origin setups. It never prints secrets.
See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for what each failure means.

## Local example values

For a throw-away local setup only (never commit real values):

```bash
export BLUSWAN_PORT=8787 BLUSWAN_HOST=127.0.0.1 BLUSWAN_AUTH=none BLUSWAN_PERSISTENCE=file BLUSWAN_DATA_DIR=.bluswan/data
export DEEPSEEK_API_KEY=… DEEPSEEK_MODEL=…
```
