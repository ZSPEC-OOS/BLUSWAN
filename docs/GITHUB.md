# GitHub workflow

BLUSWAN can drive the whole life of a coding task through GitHub, from the browser (desktop or phone):

```text
Connect GitHub → pick a repository → Clone & Open → Create task branch → BLUSWAN codes → review diff
→ Commit → Push → Create pull request → you merge on GitHub → BLUSWAN notices → Sync Main & Clean Up → next task
```

GitHub is the source of truth; BLUSWAN never merges for you. Everything is **optional**: without GitHub configuration BLUSWAN boots and local
repositories work exactly as before (the Repositories panel says GitHub is unavailable).

## How it is built

- A **GitHub App** (not personal access tokens). The server signs a short-lived JWT with the app's private key, exchanges it for an
  **installation token** (about an hour, held in memory only, refreshed before it expires) and uses that for the API and for Git over HTTPS.
- The browser only ever receives descriptions: repositories, branches, pull requests, progress. No token, key or authenticated URL is returned,
  stored in `localStorage`/`sessionStorage`/IndexedDB, written to `.git/config`, persisted in a session, or logged. Git receives the credential as
  a one-command, host-scoped HTTP header in the child process environment (never in argv or on disk); errors and logs are scrubbed.
- All writes (clone, fetch, push, branch deletion, PR creation) run on the authenticated server, per signed-in user, serialised per repository.
- Clones live at `<workspace-root>/users/<opaque-user-key>/github/<owner>/<repo>` — never a raw email or an arbitrary path. Owner and repository
  names are validated, lower-cased, and the destination is proven to be inside an allowed root with `realpath`.
- Git runs with repository hooks disabled, no prompts, no signing, argv only (no shell). The workflow never uses `--force`, `reset --hard` or `branch -D`
  without an explicit, separate confirmation (and `-D` only when the branch tip is exactly what GitHub merged).

## 1. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

| Field | Value |
|---|---|
| Name / Homepage URL | anything; your BLUSWAN URL |
| **Callback URL** | the web app's origin, e.g. `https://bluswan.example.com/` (local: `http://localhost:5173/`) |
| **Request user authorization (OAuth) during installation** | ✔ enabled — BLUSWAN uses it once to prove the installing GitHub user owns the installation |
| Setup URL | same as the callback URL, with *Redirect on update* ✔ |
| Webhook (optional) | Active ✔, URL `https://bluswan.example.com/api/github/webhook` (the runtime's public address), a random **secret** |
| Where can it be installed? | *Only on this account*, or *Any account* if others will use your runtime |

### Minimum permissions

| Permission | Level | Why |
|---|---|---|
| Repository → **Metadata** | Read | list and identify repositories (mandatory) |
| Repository → **Contents** | Read & write | clone, fetch, push task branches, delete the merged task branch |
| Repository → **Pull requests** | Read & write | create pull requests; read state and merge information |
| Repository → **Checks** | Read | show "checks passing / failing / running" |

Nothing else — no Administration, no organization permissions, no Workflows, no Actions, no Issues. (The *Commit statuses* permission is not needed;
checks come from check runs.) Subscribe to the events **Pull request**, **Check suite**, **Check run** and **Push** only if you enable the webhook.

Generate a **private key** (downloads a `.pem`) and note the **App ID**, **Client ID**, a **Client secret** and the app's **slug** (the last part of
`https://github.com/apps/<slug>`).

## 2. Configure the runtime

| Variable | Value |
|---|---|
| `GITHUB_APP_ID` | numeric App ID |
| `GITHUB_APP_PRIVATE_KEY` | the PEM text (single-line with `\n` escapes is fine) |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | from the app page; the secret also signs the single-use connect state |
| `GITHUB_APP_SLUG` | the app's slug (builds the install link) |
| `GITHUB_APP_WEBHOOK_SECRET` | optional; enables `POST /api/github/webhook` with signature verification |
| `GITHUB_API_URL` / `GITHUB_WEB_URL` | optional, GitHub Enterprise Server (`https://ghe.example.com/api/v3`, `https://ghe.example.com`) |

Configuration is all-or-nothing: setting some of the required variables and not others stops the runtime at startup with a precise message.
`npm run doctor` checks the key, reachability and that GitHub accepts the app credentials (without printing them).

Repositories need **durable storage**:

```bash
BLUSWAN_WORKSPACE_ROOTS=/var/data/repos      # clones live here; must be persistent and writable
BLUSWAN_DATA_DIR=/var/data/bluswan           # sessions, GitHub connection and task records
```

`/tmp` (or any ephemeral disk) works only for testing: clones, branches with unpushed work and conversations are lost on restart. See
[DEPLOYMENT.md](DEPLOYMENT.md) for Render.

## 3. Connect and use

1. Open **Repositories** → **Connect GitHub**. GitHub shows the install page (*All repositories* or *Selected repositories*); approving returns you to
   BLUSWAN, which verifies the signed state, the authorization code and that the installation belongs to you, then stores only installation ids.
   Add or remove repositories later on GitHub and press **Refresh**.
2. Browse (search, owner and visibility filters, "Load more"). Choose a repository → **Clone & Open** (or **Open** if it is already on the runtime).
   Progress is shown step by step and can be cancelled; an interrupted clone leaves nothing behind.
3. On the default branch BLUSWAN offers **Create Task Branch** (`bluswan/<slug>`, editable, de-duplicated with `-2`, `-3`). It fetches, fast-forwards
   the default branch and branches from it. It refuses if the tree is dirty, detached or conflicted — it never stashes or discards silently.
4. Chat. The agent edits the task branch only; it is told the repository, branch, base, push and PR state and not to commit, push, force, hard-reset or
   delete branches. Stop the run before switching branches.
5. **Commit Changes** (message suggested deterministically, files selectable, secrets such as `.env`/keys never staged) → **Push Branch**
   (`git push -u origin <branch>`, never forced) → **Create Pull Request** (title, body with commit list and *real* validation evidence, base branch,
   draft option; an existing open PR for the branch is reused). Commit and push are deliberately separate buttons.
6. Merge on GitHub. BLUSWAN detects it by manual **Refresh Status**, on reopening, after reconnect, by light polling (about once a minute, only while a PR is
   waiting and the tab is visible) and instantly through webhooks when enabled.
7. **Sync Main & Clean Up** verifies the PR is merged and the tree is clean, fetches, fast-forwards the default branch, verifies the merge commit is
   present, deletes the local branch (`git branch -d`; for squash/rebase merges Git cannot prove it, so BLUSWAN asks for a separate confirmation and only
   if the tip equals what GitHub merged), deletes the remote branch if GitHub did not already, and confirms *default branch, clean, up to date*.
8. **Start New Task**. The finished conversation stays in history with its branch and PR.

Other states are handled explicitly: PR closed without merge (never reported as merged; options to open on GitHub, create a new PR, or abandon), remote
branch deleted externally, remote commits arriving (sync fast-forwards or reports divergence — never overwrites), origin that no longer matches the
connected repository (GitHub actions disabled; BLUSWAN never rewrites the remote), detached HEAD, conflicts, access removed.

**Abandon Task** and **Remove local copy** exist separately, require confirmation when work would be lost, and never delete anything on GitHub.

## 4. Webhooks (optional)

Without webhooks everything still works (refresh/polling) — this is what you get in local development. With `GITHUB_APP_WEBHOOK_SECRET` the runtime
accepts `POST /api/github/webhook`, rejects any request whose `X-Hub-Signature-256` HMAC does not verify (constant-time), and for users with an open
BLUSWAN session updates the matching task's pull request and notifies the browser over the event stream. For local development use a tunnel
(for example smee.io) to a public URL; the endpoint is unauthenticated by design but signature-gated.

## 5. Operating notes and limits

- One operation per repository at a time (`operation_in_progress`); mutating operations refuse while the agent is running in that repository.
- The repository list indexes up to 1,000 repositories per installation per refresh (cached for a minute), paginated 30 at a time.
- Timeouts: clone 5 min, network operations 2 min, local git 30 s. Errors are categorised (`git_timeout`, `github_rate_limited`, `github_auth_expired`,
  `github_permission_denied`, `github_repository_not_found`, `git_auth_rejected`, `git_push_rejected`, …).
- Forks: records keep `upstream` and the PR base explicitly; the initial workflow targets same-repository PRs.
- Disconnecting removes BLUSWAN's record of the installation (uninstall the app on GitHub to revoke access there). Local clones and conversations are kept.
- Task/PR history is stored per user under `github_tasks` documents (file, Firestore or memory persistence); existing sessions need no migration.
