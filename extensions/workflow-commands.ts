import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const sendWorkflowPrompt = (pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string) => {
  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
    return;
  }
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
};

export default function workflowCommands(pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    description: "Kick off a structured implementation plan for the current task",
    handler: async (args, ctx) => {
      const target = args.trim();
      const prompt = [
        "Use a planning-first approach and produce a decision-complete implementation plan.",
        "Include goals, constraints, architecture, interfaces, edge cases, tests, rollout, and risks.",
        "Do not implement yet.",
        target ? `Focus target: ${target}` : "Focus target: current conversation context.",
      ].join("\n");

      sendWorkflowPrompt(pi, ctx, prompt);
      if (ctx.hasUI) ctx.ui.notify("Queued planning workflow prompt", "info");
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
}
