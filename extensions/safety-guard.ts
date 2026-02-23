import { type ExtensionAPI, isToolCallEventType } from "@mariozechner/pi-coding-agent";

type PatternRule = {
  label: string;
  pattern: RegExp;
};

const HARD_BLOCK_RULES: PatternRule[] = [
  { label: "delete root filesystem", pattern: /(^|\s)rm\s+-rf\s+\/(\s|$)/i },
  { label: "format disk", pattern: /\bmkfs(\.[a-z0-9]+)?\b/i },
  { label: "raw disk write", pattern: /\bdd\b[^\n]*\bof=\/dev\//i },
  { label: "recursive chmod root", pattern: /\bchmod\s+-R\s+777\s+\//i },
];

const CONFIRM_RULES: PatternRule[] = [
  { label: "sudo command", pattern: /(^|\s)sudo\s+/i },
  { label: "recursive delete", pattern: /\brm\s+-rf\b/i },
  { label: "force git reset", pattern: /\bgit\s+reset\s+--hard\b/i },
  { label: "force git clean", pattern: /\bgit\s+clean\s+-[^\n]*f/i },
  { label: "pipe remote script", pattern: /\b(curl|wget)\b[^\n]*\|\s*(bash|sh|zsh)\b/i },
  { label: "recursive ownership change", pattern: /\bchown\s+-R\b/i },
  { label: "publish package", pattern: /\b(npm|bun)\s+publish\b/i },
];

const findRuleMatch = (command: string, rules: PatternRule[]): PatternRule | undefined => {
  for (const rule of rules) {
    if (rule.pattern.test(command)) return rule;
  }
  return undefined;
};

export default function safetyGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command?.trim();
    if (!command) return;

    const hardBlock = findRuleMatch(command, HARD_BLOCK_RULES);
    if (hardBlock) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Blocked dangerous command: ${hardBlock.label}`, "error");
      }
      return {
        block: true,
        reason: `Blocked by safety-guard (${hardBlock.label}).`,
      };
    }

    const needsConfirm = findRuleMatch(command, CONFIRM_RULES);
    if (!needsConfirm) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked in non-interactive mode (${needsConfirm.label}).`,
      };
    }

    const allowed = await ctx.ui.confirm(
      "Potentially risky bash command",
      `Category: ${needsConfirm.label}\n\nAllow this command?\n\n${command}`,
    );

    if (!allowed) {
      return {
        block: true,
        reason: `User denied command (${needsConfirm.label}).`,
      };
    }

    ctx.ui.notify(`Allowed command after confirmation: ${needsConfirm.label}`, "warning");
  });
}
