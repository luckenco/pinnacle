const args = process.argv.slice(2);

const task = args.at(-1).replace(/^Task: /, "");

if (task === "empty") process.exit(0);

if (task === "fail") {
  process.stderr.write("fixture failure");
  process.exit(7);
}

if (task === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

const messages = [];

if (task === "tool usage") {
  messages.push({
    role: "toolResult",
    toolCallId: "nested",
    toolName: "nested",
    content: [{ type: "text", text: "nested result" }],
    isError: false,
    usage: {
      input: 5,
      output: 0,
      cacheRead: 15,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0.005, output: 0, cacheRead: 0.015, cacheWrite: 0, total: 0.02 },
    },
  });
}

messages.push({
  role: "assistant",
  provider: "test",
  model: "fixture",
  content: [
    { type: "text", text: `${task} ✓` },
    { type: "text", text: JSON.stringify({ args, cwd: process.cwd(), pid: process.pid }) },
  ],
  stopReason: "stop",
  usage: {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    reasoning: 1,
    totalTokens: 10,
    cost: {
      input: 0.001,
      output: 0.002,
      cacheRead: 0.003,
      cacheWrite: 0.004,
      total: 0.01,
    },
  },
});

const event = Buffer.from(
  messages.map((message) => JSON.stringify({ type: "message_end", message })).join("\n"),
);

// Exercise a UTF-8 character split across chunks and a final record without LF.
const split = event.indexOf(Buffer.from("✓")) + 1;

process.stdout.write(event.subarray(0, split));

setTimeout(() => process.stdout.write(event.subarray(split)), 10);

if (task === "hang") setTimeout(() => process.stdout.write("\n"), 20);
