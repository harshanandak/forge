const fs = require("node:fs");
const path = require("node:path");
const mode = process.env.HELP_FAULT;
const root = process.env.HELP_FAULT_ROOT;
const main = (process.argv[1] || "").replaceAll("\\", "/");
if (root && main.endsWith("/dist/bin/forge.js")) {
  const [noun, verb] = process.argv.slice(2);
  const stall = mode === "stall";
  if (
    noun === (stall ? "issue" : "memory") &&
    verb === (stall ? "create" : "add")
  ) {
    fs.writeFileSync(
      path.join(root, "child.json"),
      JSON.stringify({ pid: process.pid, cwd: process.cwd() }),
    );
    if (stall) {
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
