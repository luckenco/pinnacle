# Codex Fast Mode

`/fast` toggles priority service; `/fast on` and `/fast off` set it explicitly. The setting persists across sessions.

When enabled, all `openai-codex` models request `service_tier: "priority"`, including Astra and future model IDs. Other providers are unaffected. The ⚡ Fast indicator means priority is requested, not that the server has confirmed it.

Priority availability and increased usage are controlled by OpenAI. Pi does not expose per-model service-tier capabilities, so this extension uses neither a model-name allowlist nor the separate Codex CLI cache. If a model rejects priority, use `/fast off`.
