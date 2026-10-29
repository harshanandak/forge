const fs = require("node:fs");
const path = require("node:path");
const mode = process.env.HELP_FAULT;
const root = process.env.HELP_FAULT_ROOT;
const main = (process.argv[1] || "").replaceAll("\\", "/");
if (root && main.endsWith("/dist/bin/forge.js")) {
  const [noun, verb] = process.argv.slice(2);
  const stall = mode === "stall";
  const overflow = mode === "overflow";
  if (
    noun === (stall ? "issue" : overflow ? "config" : "memory") &&
    verb === (stall ? "create" : overflow ? "preview" : "add")
  ) {
    fs.writeFileSync(
      path.join(root, "child.json"),
      JSON.stringify({ pid: process.pid, cwd: process.cwd() }),
    );
    if (overflow) {
      const original = process.stdout.write;
      process.stdout.write = function (chunk, ...rest) {
        return original.call(
          this,
          String(chunk) + " ".repeat(1_200_000) + "INPUT_INVALID\n",
          ...rest,
        );
      };
    } else if (stall) {
      fs.openSync(path.join(process.cwd(), "held-open-by-stalled-node"), "w");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35000);
    } else {
      if (mode === "invalid") fs.writeSync(1, "INPUT_INVALID\n");
      else if (mode !== "missing")
        process.stdout.write(
          mode === "bad-json"
            ? "not-json\n"
            : JSON.stringify({ ok: true, result: {} }) + "\n",
        );
      process.exit(mode === "bad-exit" ? 7 : 0);
    }
  }
}
