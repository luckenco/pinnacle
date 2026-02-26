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

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

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
        target ? `Execution target: ${target}` : "Execution target: approved plan in current conversation context.",
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
          workflowPhase === "plan"
            ? "read-only tools allowed"
            : "mutating tools allowed";
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
    if (READ_ONLY_TOOLS.has(event.toolName)) return;
    return {
      block: true,
      reason: `Blocked in planning phase: "${event.toolName}" is mutating or side-effectful. Run /execute to continue.`,
    };
  });
}
