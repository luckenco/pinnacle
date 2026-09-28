# Skill toggle

`/toggle-skills` controls which of Pi's loaded skills are advertised to the model in the current repository.

- Checked skills are visible to the model for automatic selection.
- Unchecked skills are manual-only but remain available through `/skill:<name>`.
- Skill source files are never modified.

Selections are personal and repository-scoped. They are stored under `<agent-dir>/skill-toggle/` in a file keyed by the canonical Jujutsu or Git repository root. Outside a repository, the canonical working directory is used.

Use arrow keys to move, type to search, Enter to toggle, and Ctrl+S to save. Changes apply on the next model turn without reloading Pi.
