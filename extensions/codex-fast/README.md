# OpenAI Fast Mode

`/fast` toggles priority service; `/fast on` and `/fast off` set it explicitly. The setting persists across sessions.

When enabled, `openai` models with **Sign in with ChatGPT** OAuth request `service_tier: "priority"`, using the Responses API at `https://api.openai.com/v1`.

There is no model-name allowlist. OpenAI API-key requests, custom endpoints, and other providers (including `openai-codex`) are unaffected. The ⚡ Fast indicator means priority is requested, not that the server has confirmed it.

Priority availability and increased usage are controlled by OpenAI. Pi does not expose per-model service-tier capabilities, so this extension uses neither a model-name allowlist nor the separate Codex CLI cache. If a model rejects priority, use `/fast off`.

The extension wraps Pi's catalog-enabled OpenAI provider using its native provider API, tested with Pi 0.99.1. Pi still owns authentication, catalog refresh, and `models.json` overrides. Full and simple streams remain separate. Priority is set in stream options—not only in the request payload—so Pi can apply fallback priority pricing when the response omits the tier. OpenAI Responses trusts a reported tier, including `default`. This extension does not override Pi's cost calculations.

Settings remain in `~/.pi/agent/extensions/codex-fast.json`, so existing preferences carry over. They are saved atomically before the live mode changes. New subagents read the saved mode on startup; already-running processes keep their current setting. Use `/reload` after updating the installed extension. Avoid installing another extension that replaces the `openai` provider; provider registrations replace one another.
