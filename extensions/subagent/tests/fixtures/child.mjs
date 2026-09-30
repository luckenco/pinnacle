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
  stopReason: task === "assistant error" ? "error" : "stop",
  errorMessage: task === "assistant error" ? "fixture assistant error" : undefined,
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

if (task === "usage only fail") messages.length = 0;

const events = messages.map((message) => ({ type: "message_end", message }));

if (task === "usage events" || task === "usage events fail" || task === "usage only fail") {
  const usage = {
    input: 5,
    output: 0,
    cacheRead: 10,
    cacheWrite: 5,
    cacheWrite1h: 5,
    reasoning: 2,
    totalTokens: 20,
    cost: { input: 0.005, output: 0, cacheRead: 0.01, cacheWrite: 0.005, total: 0.02 },
  };

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  const timestamp = yesterday.toISOString();
  const entry = { type: "usage", id: "warm", timestamp, provider: "test", model: "cache", usage };
  events.push(
    { type: "entry_appended", entry },
    // Re-emitting the same entry must not double-count, but equal usage on
    // distinct calls must still count.
    { type: "entry_appended", entry },
    { type: "compaction_end", result: { usage }, aborted: false },
    { type: "compaction_end", result: undefined, aborted: true },
    { type: "entry_appended", entry: { type: "branch_summary", id: "branch", timestamp, usage } },
    { type: "entry_appended", entry: { type: "compaction", id: "boundary", timestamp, usage } },
    { type: "entry_appended", entry: { type: "custom", id: "custom", timestamp, usage } },
    { type: "entry_appended", entry: { type: "usage", id: "bad", timestamp, usage: { input: 1 } } },
  );
}

const event = Buffer.from(events.map((record) => JSON.stringify(record)).join("\n"));

// Exercise a UTF-8 character split across chunks and a final record without LF.
const split = event.indexOf(Buffer.from("✓")) + 1;

process.stdout.write(event.subarray(0, split));

setTimeout(() => {
  process.stdout.write(event.subarray(split));

  if (task === "paid fail" || task === "usage events fail") {
    process.stderr.write("fixture paid failure");
    process.exitCode = 7;
  }
}, 10);

if (task === "hang") setTimeout(() => process.stdout.write("\n"), 20);
