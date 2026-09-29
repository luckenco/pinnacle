# Codex Fast Mode

`/fast` toggles priority service; `/fast on` and `/fast off` set it explicitly. The setting persists across sessions.

When enabled, all `openai-codex` models request `service_tier: "priority"`, including Astra and future model IDs. Other providers are unaffected. The ⚡ Fast indicator means priority is requested, not that the server has confirmed it.

Priority availability and increased usage are controlled by OpenAI. Pi does not expose per-model service-tier capabilities, so this extension uses neither a model-name allowlist nor the separate Codex CLI cache. If a model rejects priority, use `/fast off`.

The extension wraps Pi's catalog-enabled Codex provider using Pi 0.87.1's native provider API. Pi still owns authentication, catalog refresh, and `models.json` overrides. Full and simple streams remain separate. Priority is set in stream options—not only in the request payload—so Pi can apply priority pricing even when the response omits the tier or reports `default`. Pi 0.87.1 still has an [upstream pricing bug](https://github.com/earendil-works/pi/issues/10034) for responses reporting `fast`; this extension does not override Pi's cost calculations.

Settings are saved atomically before the live mode changes. New subagents read the saved mode on startup; already-running processes keep their current setting. Use `/reload` after updating the installed extension. Avoid installing another extension that replaces the `openai-codex` provider; provider registrations replace one another.
