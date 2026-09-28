/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses OSC 777 escape sequence - no external dependencies.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 */

import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

/**
 * Send a desktop notification via OSC 777 escape sequence.
 */
const notify = (title: string, body: string): void => {
  // OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
};

const extractLastAssistantText = (messages: AgentEndEvent["messages"]): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (message?.role !== "assistant") {
      continue;
    }

    const content = message.content;

    const text = content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    return text || null;
  }

  return null;
};

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: () => "",
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: () => "",
  quote: (text) => text,
  quoteBorder: () => "",
  hr: () => "",
  listBullet: () => "",
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
  const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);

  return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null) => {
  const simplified = text ? simpleMarkdown(text) : "";
  const normalized = simplified.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return { title: "Ready for input", body: "" };
  }

  const maxBody = 200;
  const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;

  return { title: "π", body };
};

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event) => {
    const lastText = extractLastAssistantText(event.messages ?? []);
    const { title, body } = formatNotification(lastText);
    notify(title, body);
  });
}
