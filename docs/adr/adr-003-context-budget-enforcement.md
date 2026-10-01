> **Superseded:** this document describes the former V1/V2 architecture, which is no longer part of the active application. See the root `README.md` for the current architecture.

# ADR 003: Context Budget Enforcement

**Status:** Accepted

---

## Context

V1 context assembly injected up to 10 independent blocks on every turn:

- RAG retrieval block, library docs block, task decomposition block
- System prompt, conversation history, tool results
- Session digest, memory graph, shadow context, code intelligence output

When the context window was exceeded, `pruneMessages()` silently dropped the oldest turns. The problem: "oldest" often meant the original task description or a critical intermediate decision from an earlier cycle.

This produced two failure modes:
1. **Silent task drift** — the model lost its goal and started hallucinating a different task
2. **Context window collapse** — competing injectors consumed budget before tool results arrived, leaving no space for the work that actually mattered

---

## Decision

Replace injection + pruning with a strict **token budget enforcement** model:

**Reserved space (always guaranteed):**
- System prompt: 2,000 tokens
- Plan contract: 1,500 tokens
- Completion protocol: 500 tokens
- Safety buffer: 1,000 tokens

**Dynamic tiers (allocated in priority order):**
- Cycle goal + deliverables: 3,000 tokens
- Deliverable descriptions: 2,000 tokens
- Current cycle tool results: 4,000 tokens
- Repo map: 1,500 tokens
- Relevant file excerpts: 3,000 tokens

**Rules:**
- No conversation history carried across cycles (each cycle is isolated)
- No RAG injection during execution cycles
- Tool outputs are capped at the executor level before reaching the context packer
- If budget is exceeded after all tiers: throw `ContextBudgetError`, do not prune silently

The budget is implemented in `src/core-v2/contextBudget.js` and enforced by `src/core-v2/contextPacker.js`.

---

## Consequences

### Positive

- **Plan and system prompt are never dropped** — reserved space is inviolable
- **Context pressure is user-visible** — the budget bar shows current usage
- **Each cycle is isolated** — no accumulating history that degrades quality over time
- **Deterministic context assembly** — same inputs always produce the same context shape
- **ContextBudgetError is explicit** — budget overflow is a diagnosable condition, not silent drift

### Negative

- **No "learning" from previous cycle mistakes within context** — must rely on cycle summaries (≤500 chars) for cross-cycle continuity
- **Large repos may need smaller deliverables per cycle** — more files = more repo map = less budget for tool results
- **No RAG-assisted disambiguation** — the LLM must work with what's explicitly in the plan and repo map

---

## Related

- `src/core-v2/contextBudget.js`
- `src/core-v2/contextPacker.js`
- [ADR 001](./adr-001-deterministic-task-state-machine.md) — Deterministic Task State Machine
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — Context budget tiers table
