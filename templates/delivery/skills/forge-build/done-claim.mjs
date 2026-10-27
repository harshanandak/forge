import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The renderer uses this package copy, whose CLI stays alongside it across projects.
const bin = fileURLToPath(
  new URL("../../../../dist/bin/forge.js", import.meta.url),
);
function run(executable, args, cwd) {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}
function check() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (input.stop_hook_active === true || typeof input.cwd !== "string") return;
  const message = input.last_assistant_message;
  if (
    typeof message !== "string" ||
    /\bunverified\b/i.test(message) ||
    !/\b(done|fixed|ready|verified)\b/i.test(message)
  )
    return;
  const root = run("git", ["rev-parse", "--show-toplevel"], input.cwd);
  if (
    root.status !== 0 ||
    !existsSync(join(root.stdout.trim(), ".forge/config.yaml"))
  )
    return;
  const head = run("git", ["rev-parse", "HEAD"], input.cwd);
  let covered = false;
  if (
    head.status === 0 &&
    /^\s*(?:[-*]\s*)?not covered\s*:\s*\S.*$/im.test(message)
  ) {
    const ids = new Set(
      message.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/g) ?? [],
    );
    for (const id of ids) {
      const shown = run(
        process.execPath,
        [bin, "check", "show", "--id", id],
        input.cwd,
      );
      try {
        const response = JSON.parse(shown.stdout);
        const receipt = response.result;
        if (
          shown.status === 0 &&
          response.ok === true &&
          receipt?.id === id &&
          receipt.status === "PASS" &&
          receipt.subject === head.stdout.trim()
        ) {
          covered = true;
          break;
        }
      } catch {
        /* Missing or unreadable proof is unverified. */
      }
    }
  }
  if (!covered)
    console.log(
      JSON.stringify({
        decision: "block",
        reason:
          'Add a PASS check receipt id for current HEAD and a "not covered: ..." line, or say "unverified".',
      }),
    );
}
check();
