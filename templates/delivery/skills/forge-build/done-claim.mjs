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
  if (typeof message !== "string") return;
  const prose = message
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`/g, " ")
    .replace(/[^.!?\n]*\?/g, " ")
    .replace(/(?:\b(?:not|yet|once|when|until)\b|n['’]t)[^.!?\n]*/gi, " ");
  if (
    !/\b(done|fixed|ready|verified)\b/i.test(prose) ||
    /(?<![\w-])unverified(?![\w-])/i.test(prose)
  )
    return;
  const root = run("git", ["rev-parse", "--show-toplevel"], input.cwd);
  if (
    root.status !== 0 ||
    !existsSync(join(root.stdout.trim(), ".forge/config.yaml"))
  )
    return;
  const head = run("git", ["rev-parse", "HEAD"], input.cwd);
  if (
    head.status === 0 &&
    /^\s*(?:[-*]\s*)?not covered\s*[:–—-]\s*\S.*$/im.test(message)
  ) {
    const ids = new Set(
      message
        .match(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi)
        ?.map((id) => id.toLowerCase()) ?? [],
    );
    for (const id of ids) {
      const shown = run(
        process.execPath,
        [bin, "check", "show", "--id", id],
        root.stdout.trim(),
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
        )
          return;
      } catch {
        /* Missing or unreadable proof is unverified. */
      }
    }
  }
  console.log(
    JSON.stringify({
      decision: "block",
      reason:
        'Add a PASS check receipt id for current HEAD and a "not covered: ..." line, or say "unverified".',
    }),
  );
}
check();
