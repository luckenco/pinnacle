import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const task = args.at(-1).replace(/^Task: /, "");
if (task === "fail") {
  process.stderr.write("fixture failure");
  process.exit(7);
}
if (task === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
const promptPath = args[args.indexOf("--append-system-prompt") + 1];
const event = Buffer.from(
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: `${task} ✓` },
        {
          type: "text",
          text: JSON.stringify({
            args,
            cwd: process.cwd(),
            promptPath,
            prompt: readFileSync(promptPath, "utf8"),
            pid: process.pid,
          }),
        },
      ],
      stopReason: "stop",
    },
  }),
);
// Exercise a UTF-8 character split across chunks and a final record without LF.
const split = event.indexOf(Buffer.from("✓")) + 1;
process.stdout.write(event.subarray(0, split));
setTimeout(() => process.stdout.write(event.subarray(split)), 10);
if (task === "hang") setTimeout(() => process.stdout.write("\n"), 20);
