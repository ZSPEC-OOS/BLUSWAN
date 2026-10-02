# Mobile workspace (Phase 12)

On phone-sized screens (≤ 900 px — the shell's existing breakpoint) BLUSWAN is a conversation first:

```text
☰             BLUSWAN             ⚙
          repo · branch
─────────────────────────────────
           conversation
─────────────────────────────────
[ Ask BLUSWAN…                    ]
```

This is a recomposition of controls that already exist. No state, Git/GitHub logic or backend was added: the phone surfaces receive the same
store snapshot and actions as the desktop toolbar.

| Surface | Contents (each only if the capability exists) | Reuses |
|---|---|---|
| **Header** | ☰, BLUSWAN + `repository · branch` (truncating) or "No repository", ⚙. A dot on ☰ means the repository needs you (conflicts, merged and ready for cleanup, closed PR, detached HEAD, remote mismatch, changes on the default branch). Save problems appear here; healthy saves don't. | workspace/branch from the shell snapshot and GitHub workflow state |
| **☰ Workspace** (left drawer) | **Current** repo + branch · **Repositories**: Browse GitHub, Open Local Repository · **Git** (repository open): the workflow card (next step, Branches, Sync, commit/push/PR/merge actions), Changes · **Conversations**: New chat + history with PR badges | `GithubPanel`, `RepositoryOpener` (also used by the desktop settings dialog), `WorkflowBar`, workspace review sheet, `SessionList` |
| **⚙ Settings** (right drawer) | **AI**: model · **Editing**: edit mode · **Connections**: GitHub status → GitHub panel · **Runtime**: status text, Diagnostics · Account | `ModelSelector`, the permission-mode state, GitHub store status, connection state, `DiagnosticsPanel`; "Provider status & default model" opens the existing settings dialog |

Behaviour:

- Opening or closing a drawer only toggles local view state. It never resets the conversation, repository, branch, run, stream or connection (asserted in the browser suite with a streaming run).
- Dialogs, the repository browser and the changes sheet open above the drawers; Escape, the ✕ button or a tap outside closes a drawer and focus returns to the control that opened it.
- Rows are full width with ≥ 48 px targets; header buttons are 44 px; the composer text is 16 px (no iOS zoom); safe-area insets are applied to the header, drawers and composer.
- Keyboard: where the browser resizes the layout (Chrome/Android) nothing is needed; where it overlays the keyboard (iOS Safari) `useKeyboardInset` publishes `--kb-inset` from `visualViewport` and the shell shrinks by it.
- Errors stay on the main screen: "Connection lost — reconnecting…" and other connection states remain a banner under the header; GitHub errors stay in the GitHub panels and dialogs; Settings only mirrors the runtime state.
- Desktop (> 900 px) is unchanged: toolbar with model/permission selectors, sidebar, workflow bar, settings dialog.

Future considerations (deliberately not built): a swipe-to-open gesture, a dedicated "Pull Request" row (the pull-request actions live in the workflow card), per-repository quick switching in the header, and showing the persistent save state on phones.
