# Subagent model preferences

Run `/subagent-models` to configure:

- **Eye:** an ordered pool of capable models for reasoning and independent perspectives. The first is primary.
- **Hand:** one model for bounded implementation. It may also belong to the eye pool.
- **Reasoning:** an explicit Pi thinking level for each eye assignment and separately for the hand.

The active model and scoped-model settings are unchanged. Pinnacle's `subagent` tool applies these assignments when a task requests `role: "eye"` or `role: "hand"`; tasks can still inherit the parent or use an exact model override.

## Usage

1. Type to search by provider, model ID, or display name.
2. In **Eye**, press Enter on a model, then choose a supported reasoning level with Enter. New selections append to the pool. Even non-reasoning models require explicitly choosing `off`.
3. Use Alt+↑/↓ to reorder a selected eye, including while searching.
4. Press Tab for **Hand**. Enter on a model, then choose its reasoning level to set or replace the hand. The same model can have a different level as an eye.
5. Enter on an assigned model to edit its level or choose **Remove**. Esc backs out of the level list without changing the draft.
6. Ctrl+S saves and closes from the model list once at least one eye and a hand are assigned. Esc there discards all edits.

Navigation, reorder, save and cancel respect Pi's corresponding keybindings; Tab switches pools. A focused overlay keeps these keys working in regular and fullscreen mode. The list shrinks with the terminal; very short panes require resizing before editing. Choices show exact provider/model IDs so a subscription route and an API route are not confused. Selection does not invoke a model or estimate spending.

Examples:

- For a second-opinion pool, select your primary frontier model, then approved alternatives from other model families.
- To replace your implementation model, switch to Hand, search for the replacement and select it. There is no hand pool or automatic fallback.
- To promote an eye, select its row and move it up until it is numbered 1.

Supported levels come from Pi's `getSupportedThinkingLevels(model)`. Search preserves the order of selected eyes, so reordering remains visible while filtering. The picker refreshes Pi's locally available models on each invocation, without requesting a network catalog refresh. Availability means Pi sees configured authentication, not that an inference request is guaranteed to succeed. Dispatch validates the configured model and saved level against its current catalog snapshot before launching. No model is automatically chosen based on age, price or family. Catalog updates and family-diversity checks are not owned by this extension.

Saved models that are no longer available remain visible and can be removed when the role remains complete, but cannot be newly assigned or given a new level without model metadata. Untouched unavailable preferences survive Save. A saved level that Pi no longer supports is flagged, not silently changed. A refresh failure disables new assignments and level edits for that invocation rather than using stale choices; existing preferences can still be removed or reordered. Reopen after fixing authentication or catalog errors.

## Storage

Preferences live at `<agent-dir>/extensions/subagent-models.json`, normally `~/.pi/agent/extensions/subagent-models.json`. `getAgentDir()` respects Pi's agent-directory configuration. The extension never edits `settings.json` or credential files.

```json
{
  "eye": ["provider/primary-model", "other-provider/reviewer-model"],
  "hand": "provider/small-model",
  "reasoning": {
    "eye": { "provider/primary-model": "high", "other-provider/reviewer-model": "medium" },
    "hand": "low"
  }
}
```

Missing or incomplete configuration is readable so the picker can repair it, but cannot be saved or used for role dispatch. Pi warns at session start until at least one eye and a hand are assigned. IDs are exact, not patterns; model IDs can contain slashes or spaces. Every saved assignment must have an explicit reasoning level, including `off`. A hand can have a different level from the same model in the eye pool. If a saved level is no longer supported, press the configured Down key in the reasoning list before applying a new level—Enter alone won't replace it with `off`. Files from the earlier experimental format without `reasoning` must be updated or removed manually; they are not silently migrated. Malformed, duplicate, unknown-field or unreadable configuration causes a visible error, not a reset.

Each picker owns its draft. Save briefly takes an exclusive `.lock`, compares the original file contents, then atomically renames a temporary file into place. A concurrent change or lock refuses the save; reopen to retry. A failed save closes the picker without saving the draft. External editors do not participate in locking. After a process crash, remove a leftover `.lock` only after checking that no writer is still active. Atomic rename prevents partial files, not power-loss durability guarantees.

## Design

Usage drives one data type: `SubagentModels = { eye: string[]; hand: string | null; reasoning: { eye: Record<string, ModelThinkingLevel>; hand: ModelThinkingLevel | null } }`. Array order owns eye priority; a scalar owns the single hand. Every assignment has a role-specific level. File-shape validation belongs at the file boundary; completeness is enforced on Save and role dispatch. There are no family classifiers, quality guesses, or inference side effects.

- `index.ts`: command, fresh availability, explicit Save/cancel, startup warning, and concise role context for the orchestrator.
- `picker.ts`: isolated draft, search, selection, ordering, public Pi TUI components.
- `config.ts`: strict loading and conflict-aware atomic persistence.

**Synthesis:** compared a built-in-dialog wizard with one scoped-style picker. Chose the picker for live search and ordering without repeated dialogs. Adapted the wizard's exclusive lock and conflict refusal; rejected forced overwrite, a generalized settings framework, schema versions and model-ID brands. Pi's built-in scoped-models component is not publicly exported, so this uses public `Input`, fuzzy matching and width helpers instead of a private import. Tradeoff: a small custom list renderer and TUI-only configuration, rather than RPC support. Dispatch consumes the saved data directly; skills choose roles and overflow seats.

## Development

The package auto-discovers this extension. To try this checkout before publishing/updating the package:

```sh
pi -e ~/Code/pinnacle/extensions/subagent-models/index.ts
```

Do not load both the checkout and an installed copy of this extension in the same session.

```sh
bun test extensions/subagent-models
bun run check
```

Pinnacle skills use eyes for exploration and judgment and the hand for bounded implementation. Eye task count remains independent of pool size: skills use every configured eye first, then the orchestrator chooses explicit overflow models under that workflow's existing rules. Dispatch never reserves a judge eye, cycles the pool, or silently substitutes an unavailable assignment. No hard spending limit is implemented here.
