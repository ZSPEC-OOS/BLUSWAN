# Providers

BLUSWAN supports DeepSeek, Kimi, OpenAI and Anthropic through one provider abstraction. All four run the same agent
loop, tools, context engine, validation and persistence; choosing a model changes only which adapter streams the next
turn. There is **no automatic routing and no fallback chain**: the model you select is the model that runs, and a
provider failure is shown as a failure.

Credentials are read **only from the server's environment** (never prefix them with `VITE_` — those values are
compiled into the browser bundle and are ignored). The browser is told whether a provider is *configured*, never
the key. Per-user keys are not supported yet (that needs a server-side secrets service).

Each provider needs `<NAME>_API_KEY` and a model (`<NAME>_MODEL`); `<NAME>_BASE_URL` is optional.

| Provider | Variables | Default base URL | API used |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Chat Completions (streaming, tools) |
| Kimi (Moonshot) | `KIMI_API_KEY`, `KIMI_MODEL`, `KIMI_BASE_URL` | `https://api.moonshot.ai/v1` | Chat Completions (streaming, tools) |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Responses API, stateless (`store: false`) |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Messages API (`anthropic-version: 2023-06-01`) |

The configured model is always offered in the model picker, together with a few well-known ids per provider. Any model
id the provider accepts can be configured; unknown ids use the provider's fallback capabilities and are marked as
not in BLUSWAN's table.

## Capabilities

Capabilities are per model (longest-prefix table in each adapter) and drive runtime behaviour:

| | tools | streaming | reasoning | parallel tool calls | context window | max output |
|---|---|---|---|---|---|---|
| `deepseek-chat` | yes | yes | no | yes | 128k | 8k |
| `deepseek-reasoner` | yes | yes | yes | yes | 128k | 32k |
| `kimi-k2-thinking` | yes | yes | yes | yes | 256k | 16k |
| `kimi-k2*`, `kimi-latest`, `moonshot-v1-128k` | yes | yes | — | yes | 128k | 8k |
| `gpt-5*` | yes | yes | yes | yes | 400k | 32k |
| `o3*`, `o4*` | yes | yes | yes | yes | 200k | 32k |
| `gpt-4.1*` | yes | yes | no | yes | 1M | 16k |
| `gpt-4o*` | yes | yes | no | yes | 128k | 16k |
| `claude-*` | yes | yes | no (extended thinking is not enabled) | yes | 200k | 8k |

A model without tool calling or streaming cannot run the coding agent: sending it a message in a workspace fails early with
`unsupported_feature`, and the picker disables it. These tables are metadata, easy to correct in the adapter files.

**Verification status.** Every adapter passes the shared offline contract suite using each provider's documented wire
format. They have *not* been exercised against the live services from this repository's CI; use the opt-in smoke tests
(below) with your own credentials.

## Adding a provider

1. Create `src/providers/<name>.js` exporting a `create<Name>Provider(deps)` built with `createAdapter(...)` (see `kimi.js` for a chat-completions service, `anthropic.js` for a custom wire format). Provide `capabilitiesFor(model)` and a protocol: `normalizeMessages`, `normalizeTools`, `build(config, request, caps)`, `createParser()`.
2. Register it in `createStandardProviders` (`registry.js`), add its env variables to `runtimeConfig.js`, `serverCredentialStore.js` and `labels.js`.
3. Add a row to `contract.test.mjs` and a fixture renderer in `testing/wire.js`. Nothing in the agent loop changes.

## Live smoke tests (optional, never in CI)

```bash
DEEPSEEK_API_KEY=… DEEPSEEK_MODEL=… npm run test:deepseek     # also test:kimi, test:openai, test:anthropic
```

Each creates a disposable git repository under the OS temp directory, asks the model to fix a one-line bug, and checks
that a real tool call happened, the file changed and the fixture's tests pass. Exit codes: 0 PASS, 1 FAIL, 2 NOT RUN
(no credentials). `npm run eval -- --provider <id>` runs the larger coding evaluation (see [DEVELOPMENT.md](DEVELOPMENT.md)).
