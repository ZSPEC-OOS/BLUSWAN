# Adaptive Intelligence Routing

BLUSWAN can choose how much model capability to spend on each request. Routing is **server-side**, optional, and changes
only *which profile* the one existing agent loop runs on. It never changes permissions, workspace confinement, Git or
GitHub behaviour: **Pro is smarter, not more privileged.**

```text
browser → runtime → routing policy → resolved profile → existing provider-neutral agent loop
                                                         (context · tools · validation · recovery · permissions · persistence)
```

## Profiles and modes

| Profile | Default | Used for |
|---|---|---|
| Flash (`fast`) | `deepseek` / `deepseek-flash` / reasoning `high` | routine, well-scoped work |
| Pro (`advanced`) | `deepseek` / `deepseek-v4-pro` / reasoning `high` | hard, broad or risky work |

| Mode | Behaviour |
|---|---|
| **Auto** (recommended for new conversations) | BLUSWAN picks Flash or Pro for each *new* request; a Flash run may escalate once to Pro |
| **Flash** | Always Flash. The router is skipped; never escalates |
| **Pro** | Always Pro. The router is skipped; never downgrades |

Existing installs and historical conversations stay on their manual provider/model; they are never silently converted to
Auto. Explicit provider/model selection (Kimi, OpenAI, Anthropic, any model id) is always available in the model picker
and under *Choose a specific model* in mobile Settings.

## Configuration

See [DEPLOYMENT.md](DEPLOYMENT.md#adaptive-intelligence-routing-optional). Routing is enabled when any `BLUSWAN_MODEL_MODE`,
`BLUSWAN_FAST_*` or `BLUSWAN_ADVANCED_*` variable is set. Auto is available only when both profiles are usable; there is
**no silent substitution**: an unavailable Pro never runs Flash, and an unavailable Flash never spends Pro. The client is
told only profile ids, labels, providers and models (`bootstrap.routing`) — no keys, thresholds, weights or classifier prompt.

## How a request is routed (Auto)

1. **Deterministic signals** (`src/routing/signals.js`): request kind (question, trivial edit, change, debugging, refactor,
   follow-up), scope (files named, repo-wide wording), steps, risk areas that matter *together with a change* (security,
   persistence/migration, concurrency, architecture), ambiguity, and runtime evidence (unresolved validation failures, a
   failed previous run). Message length is not complexity, and a single word such as "auth" or "refactor" never decides.
2. **Score and gates** (`policy.js`): a 0–100 score with centralised thresholds — 0–35 Flash, 65–100 Pro, 36–64 ambiguous.
   Safety gates force Pro for dangerous combinations (security + structural change, persistence migrations,
   concurrency debugging, multi-component root-cause debugging, repo-wide refactors, repeated failures).
3. **Bounded classifier** (`classifier.js`) for the ambiguous band only: one tool-less call on the Flash profile with thinking
   off, a ~120-token output cap, a timeout, and a strictly validated JSON answer `{route, confidence, scope, risk}`.
   Low confidence or high risk → Pro. Timeout, error, malformed or invalid output → the deterministic default, which for an
   irreducibly ambiguous request is **Pro**. Chain-of-thought is never requested or stored.
4. **Follow-ups** such as "Fix it." inherit the previous task's difficulty (and a failed validation pushes towards Pro).

Each request is routed independently; the route is sticky for the whole run. Routing is cheap, runs per request/run (no
global state), and is cancellable at every stage — after Stop, no further model call is made.

## Escalation (Auto, Flash → Pro, once)

At the top of an agent turn — never mid-stream — the runtime checks real evidence and may switch the *remaining* turns to
Pro: repeated validation failures after repair attempts, consecutive turns with no progress, or a task that has grown far
beyond its start (`src/routing/escalation.js`). Provider outages, 429s and a single ordinary failure are *not* evidence;
those are retry/recovery concerns. History, files, validation and permissions carry over; completed tool calls are never
replayed. If Pro cannot run, the run stays on Flash. The optional "ask for higher reasoning" model tool is not implemented.

## Events, persistence and usage

- Events: `model.route.selected` `{mode, tier, provider, model, reasoningEffort, source, reasonCodes}` and
  `model.route.escalated` `{from, to, provider, model, reasoningEffort, reasonCode}` — codes only, never prompts or reasoning.
- Sessions store the user's **preference** (`modelPreference`: `auto`/`fast`/`advanced`, or null = manual) separately from the
  executed model (`session.model`). Stored sessions without the field restore as manual selections. The user's default mode for
  new conversations lives in settings (`modelMode`, or `manual`).
- Each run record carries `route`: requested mode, initial and final tier, escalation, source, reason codes, score, classifier
  outcome/usage (separately), and per-tier segments with turns, tool calls and input/output/reasoning/cached tokens and duration.
  No dollar prices are hard-coded.
- Logs record ids and codes only — never keys, authorization headers, repository contents, full prompts, reasoning or classifier text.

## User interface

Settings → Model: **Auto (recommended)**, **Flash**, **Pro** (radio-style on phones and in the desktop Settings dialog; a
combined selector on desktop). Each run shows a quiet line — "Auto · Flash", "Auto · Pro", "Flash", "Pro" — plus
"Escalated for deeper reasoning" after an escalation.

## Testing

`npm test` covers the router matrix, policy, classifier, escalation, runtime integration, persistence, service, client and the
DeepSeek contract; `npm run test:e2e` (`e2e/routing.spec.mjs`) drives the real server with scripted `fake-fast`/`fake-pro` models
on desktop and phone viewports. Live checks are opt-in and billable: `npm run test:deepseek-flash`, `npm run test:deepseek-pro`
(run separately) and `npm run eval:routing` (same tasks forced Flash, forced Pro and Auto; raw outcomes, no ranking).
