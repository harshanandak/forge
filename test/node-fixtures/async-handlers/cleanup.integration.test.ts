// [integration] Drive the journey's real finally block with stale evidence and a live orphan.
import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRunning, waitUntilGone } from "../process/liveness.ts";

const root = resolve(import.meta.dirname, "../../..");
const node = Bun.which("node");
if (!node) throw Error("Node is required");

function journey(injected: string) {
  const work = mkdtempSync(join(tmpdir(), "forge-649-cleanup-"));
  copyFileSync(join(root, "package.json"), join(work, "package.json"));
  symlinkSync(join(root, "dist"), join(work, "dist"), "junction");
  symlinkSync(
    join(root, "node_modules"),
    join(work, "node_modules"),
    "junction",
  );
  const original = readFileSync(
    join(import.meta.dirname, "journey.mjs"),
    "utf8",
  );
  const marker = 'try {\n  if (["all", "async"].includes(mode)) {';
  expect(original.replaceAll("\r\n", "\n").split(marker)).toHaveLength(2);
  writeFileSync(
    join(work, "journey.mjs"),
    original
      .replaceAll("\r\n", "\n")
      .replace(
        marker,
        `try {\n${injected}\n  if (["all", "async"].includes(mode)) {`,
      ),
  );
  return { work };
}

function run(injected: string) {
  const { work } = journey(injected);
  try {
    copyFileSync(
      join(import.meta.dirname, "deadline.mjs"),
      join(work, "deadline.mjs"),
    );
    writeFileSync(
      join(work, "liveness.mjs"),
      new Bun.Transpiler({ loader: "ts" }).transformSync(
        readFileSync(
          join(import.meta.dirname, "../process/liveness.ts"),
          "utf8",
        ),
      ),
    );
    return spawnSync(node!, [join(work, "journey.mjs"), "cleanup-regression"], {
      cwd: work,
      env: { ...process.env, FORGE_DEVICE_ROOT: join(work, "device") },
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("a stale ready PID cannot kill an unrelated live process", async () => {
  const victim = spawn(
    node,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  const exited = new Promise((resolve) => victim.once("exit", resolve));
  try {
    await new Promise((resolve) => victim.stdout.once("data", resolve));
    const result = run(
      `writeFileSync(join(root, "stale.ready"), ${JSON.stringify(String(victim.pid))});`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(
      isRunning(victim.pid!),
      "unrelated process must survive journey cleanup",
    ).toBe(true);
  } finally {
    victim.kill("SIGKILL");
    await exited;
  }
}, 30000);

test.each([false, true])(
  "cleanup stops a real orphan and preserves its failure (early socket close: %s)",
  async (earlyClose) => {
    const source = readFileSync(
      join(import.meta.dirname, "journey.mjs"),
      "utf8",
    );
    let grandchild = source.slice(
      source.indexOf("  const grandchild ="),
      source.indexOf("  const childSource ="),
    );
    if (earlyClose) {
      const stop = "socket.on('data',()=>process.exit(0));";
      expect(grandchild).toContain(stop);
      grandchild = grandchild.replace(
        stop,
        "socket.on('data',()=>{socket.destroy();setTimeout(()=>process.exit(0),1000);});",
      );
    }
    const result = run(`
    const ready = join(root, "orphan.ready");
    const late = join(root, "orphan.late");
    ${grandchild}
    const orphan = spawn(process.execPath, ["-e", grandchild], { cwd: root, detached: true, stdio: "ignore" });
    orphan.unref();
    while (!existsSync(ready)) await pause(10);
    console.log("ORPHAN", readFileSync(ready, "utf8"));
    throw Error("counterfactual evidence");
  `);
    const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.status, output).toBe(1);
    expect(result.stderr, output).toContain("counterfactual evidence");
    const pid = Number(result.stdout.match(/ORPHAN (\d+)/)?.[1]);
    expect(pid, output).toBeGreaterThan(0);
    expect(await waitUntilGone([pid]), "real orphan must be stopped").toBe(
      true,
    );
  },
  30000,
);
