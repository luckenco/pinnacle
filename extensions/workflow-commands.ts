import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const sendWorkflowPrompt = (pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string) => {
  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
    return;
  }
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
};

type WorkflowPhase = "plan" | "execute";
let workflowPhase: WorkflowPhase = "execute";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);

const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)\b/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
  /\bservice\s+\S+\s+(start|stop|restart)\b/i,
];

const SAFE_BASH_PATTERNS = [
  /^\s*cat\b/i,
  /^\s*head\b/i,
  /^\s*tail\b/i,
  /^\s*less\b/i,
  /^\s*more\b/i,
  /^\s*grep\b/i,
  /^\s*find\b/i,
  /^\s*ls\b/i,
  /^\s*pwd\b/i,
  /^\s*echo\b/i,
  /^\s*printf\b/i,
  /^\s*wc\b/i,
  /^\s*sort\b/i,
  /^\s*uniq\b/i,
  /^\s*diff\b/i,
  /^\s*file\b/i,
  /^\s*stat\b/i,
  /^\s*du\b/i,
  /^\s*df\b/i,
  /^\s*tree\b/i,
  /^\s*which\b/i,
  /^\s*whereis\b/i,
  /^\s*type\b/i,
  /^\s*env\b/i,
  /^\s*printenv\b/i,
  /^\s*uname\b/i,
  /^\s*whoami\b/i,
  /^\s*id\b/i,
  /^\s*date\b/i,
  /^\s*uptime\b/i,
  /^\s*ps\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|rev-parse)\b/i,
  /^\s*git\s+ls-/i,
  /^\s*jq\b/i,
  /^\s*sed\s+-n\b/i,
  /^\s*awk\b/i,
  /^\s*rg\b/i,
  /^\s*fd\b/i,
  /^\s*bat\b/i,
  /^\s*exa\b/i,
  /^\s*xargs\s+(grep|rg|cat|wc|head|tail)\b/i,
];

const isSafeBashCommand = (command: string): boolean => {
  const normalized = command.trim();
  if (!normalized) return false;

  const isDestructive = DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(normalized));
  if (isDestructive) return false;

  return SAFE_BASH_PATTERNS.some((pattern) => pattern.test(normalized));
};

export default function workflowCommands(pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    description: "Enter planning phase (read-only tools) and request a decision-complete plan",
    handler: async (args, ctx) => {
      const target = args.trim();
      workflowPhase = "plan";
      const prompt = [
        "Planning phase is active. Do analysis only.",
        "Produce a decision-complete implementation plan.",
        "Include goals, constraints, architecture, interfaces, edge cases, tests, rollout, and risks.",
        "Do not implement yet.",
        target ? `Focus target: ${target}` : "Focus target: current conversation context.",
      ].join("\n");

      sendWorkflowPrompt(pi, ctx, prompt);
      if (ctx.hasUI) ctx.ui.notify("Planning phase enabled (mutating tools blocked)", "info");
    },
  });

  pi.registerCommand("execute", {
    description: "Enter execution phase and implement the approved plan",
    handler: async (args, ctx) => {
      const target = args.trim();
      workflowPhase = "execute";
      const prompt = [
        "Execution phase is active.",
        "Implement the approved plan from this conversation.",
        "Before edits, restate the plan briefly and list assumptions.",
        "After edits, run relevant checks and report changed files and residual risks.",
        target
          ? `Execution target: ${target}`
          : "Execution target: approved plan in current conversation context.",
      ].join("\n");

      sendWorkflowPrompt(pi, ctx, prompt);
      if (ctx.hasUI) ctx.ui.notify("Execution phase enabled (mutating tools allowed)", "info");
    },
  });

  pi.registerCommand("workflow-status", {
    description: "Show whether the agent is in plan or execute phase",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        const details =
          workflowPhase === "plan" ? "read-only tools allowed" : "mutating tools allowed";
        ctx.ui.notify(`Workflow phase: ${workflowPhase} (${details})`, "info");
      }
    },
  });

  pi.registerCommand("review", {
    description: "Run a findings-first code review workflow",
    handler: async (args, ctx) => {
      const target = args.trim();
      const prompt = [
        "Review with a findings-first mindset.",
        "Prioritize bugs, regressions, security issues, and missing tests.",
        "Order findings by severity and include file/line references.",
        target ? `Review target: ${target}` : "Review target: current repository changes/context.",
      ].join("\n");

      sendWorkflowPrompt(pi, ctx, prompt);
      if (ctx.hasUI) ctx.ui.notify("Queued review workflow prompt", "info");
    },
  });

  pi.on("tool_call", async (event) => {
    if (workflowPhase !== "plan") return;
    if (!READ_ONLY_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked in planning phase: "${event.toolName}" is mutating or side-effectful. Run /execute to continue.`,
      };
    }

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown })?.command ?? "");
      if (!isSafeBashCommand(command)) {
        return {
          block: true,
          reason: `Blocked in planning phase: bash command is not allowlisted as read-only. Run /execute to continue.\nCommand: ${command}`,
        };
      }
    }

    return;
  });
}
