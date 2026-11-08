import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { approvalReply } from "../../fixtures/owner-approval.mjs";

setDefaultTimeout(90_000);

const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
const node = Bun.which("node")!;
type Hook = {
  file: string;
  config: {
    hooks: {
      SessionStart: {
        matcher?: string;
        hooks: { type: string; command: string }[];
      }[];
    };
  };
};

test("integration: rendered memory command reads fresh rules from the installed CLI and caps whole notes", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-memory-hook-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".forge"), { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "memory-hook",
      scripts: { test: "node --version" },
    }),
  );
  writeFileSync(join(project, "package-lock.json"), '{"lockfileVersion":3}');
  writeFileSync(
    join(project, ".forge/config.yaml"),
    '{"schemaVersion":"forge.config/1","blocks":{}}',
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORGE_DEVICE_ROOT: join(root, "device"),
  };
  delete env.CLAUDE_PROJECT_DIR;
  const call = <T>(args: string[]): T => {
    const result = spawnSync(node, [bin, ...args], {
      cwd: project,
      env,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; result: T };
    expect(envelope.ok).toBe(true);
    return envelope.result;
  };
  const add = (text: string, scope: string, tags: string[] = ["rule"]) =>
    call<{ id: string }>([
      "memory",
      "add",
      "--input",
      JSON.stringify({ level: "device", text, scope, tags }),
    ]);
  // An owner-tagged add is only proposed: the owner's relayed reply to memory accept serves it.
  const accept = (ids: string[]) => {
    // The owner is shown each note's revision and text; the approval binds exactly those.
    const items = ids.map((id) => {
      const shown = call<{
        note: { revision: number; text: { text: string } };
      }>(["memory", "show", id]);
      return { id, revision: shown.note.revision, text: shown.note.text.text };
    });
    const send = (approval: unknown) => {
      const result = spawnSync(
        node,
        [
          bin,
          "memory",
          "accept",
          "--input",
          JSON.stringify({ items, approval }),
        ],
        {
          cwd: project,
          env: { ...env, FORGE_AGENT: "memory-hook-test" },
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        },
      );
      expect(result.error).toBeUndefined();
      return JSON.parse(result.stdout) as {
        ok: boolean;
        error?: { code: string };
        result?: { request?: { id: string } };
      };
    };
    const asked = send({ by: "owner", quote: "Accept these rules." });
    const done = send(
      approvalReply(
        asked,
        { harness: "fixture", thread: "fixture" },
        "Accept these rules.",
      ),
    );
    expect(done.ok).toBe(true);
  };
  try {
    const config = call<{ revision: string }>(["config", "show"]);
    call([
      "template",
      "import",
      "delivery",
      "--expect-revision",
      config.revision,
    ]);
    const rendered = call<Hook>(["agent", "memory", "claude"]);
    expect(rendered.file).toBe("~/.claude/settings.json");
    expect(rendered.config.hooks.SessionStart).toHaveLength(1);
    expect(rendered.config.hooks.SessionStart[0]!.matcher).toBeUndefined();
    const command = rendered.config.hooks.SessionStart[0]!.hooks[0]!.command;
    const execute = () => {
      const result = spawnSync(command, {
        cwd: project,
        env,
        shell: true,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout;
    };
    // Render first, then add: a cached packet cannot satisfy these assertions.
    accept([
      add("fresh general rule", "general").id,
      add("fresh project rule", "project").id,
    ]);
    add("untagged private text", "project", []);
    const packet = execute();
    expect(packet).toMatch(
      /- \[general\] device\/note-1 \(created \d{4}-\d{2}-\d{2}\) fresh general rule\n/,
    );
    expect(packet).toMatch(
      /- \[project\] device\/note-2 \(created \d{4}-\d{2}-\d{2}\) fresh project rule\n/,
    );
    expect(packet).toContain("Forge memory notes: general 1, project 2.");
    expect(packet).not.toContain("untagged private text");
    const pointer = call<{ text: { text: string } }>(["memory", "rules"]);
    expect(packet.endsWith(`${pointer.text.text}\n`)).toBe(true);
    expect(pointer.text.text).not.toContain("fresh general rule");
    const codex = call<Hook>(["agent", "memory", "codex"]);
    expect(codex.file).toBe("~/.codex/hooks.json");
    expect(codex.config.hooks.SessionStart[0]!.hooks[0]!.command).toBe(command);
    const t3 = call<{ instruction: string }>(["agent", "memory", "t3"]);
    expect(t3.instruction).toMatch(/underlying harness/i);
    expect(t3.instruction.split("\n")).toHaveLength(1);
    env.FORGE_DEVICE_ROOT = join(root, "cap-device");
    const prefixLength = "- [general] device/note-1 (created YYYY-MM-DD) "
      .length;
    accept(
      [
        "a".repeat(3000),
        "b".repeat(3000 - 2 * prefixLength - 1),
        "drop one",
        "drop two",
      ].map((text) => add(text, "general").id),
    );
    const capped = execute();
    expect(capped).toContain("2 more rule notes did not fit; search them.\n");
    const lines = capped.split("\n").filter((line) => line.startsWith("- ["));
    expect(lines).toHaveLength(2);
    expect(lines.join("\n").length).toBe(6000);
    const docs = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../../../src/blocks/agent/docs.json"),
        "utf8",
      ),
    ) as {
      operations: { "agent.memory": { examples: { command: string }[] } };
    };
    for (const id of ["codex", "claude"]) {
      const example = docs.operations["agent.memory"].examples.find(
        ({ command }) => command.startsWith(`forge agent memory ${id}`),
      );
      expect(example).toBeDefined();
      const [executable, ...args] = example!.command.split(/\s+/);
      expect(executable).toBe("forge");
      const output = spawnSync(node, [bin, ...args], {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      expect(output.error).toBeUndefined();
      expect(output.status).toBe(0);
      let envelope: { ok: boolean; result: Hook } | undefined;
      try {
        envelope = JSON.parse(output.stdout) as typeof envelope;
      } catch {
        // Display text cannot be merged as hook JSON.
      }
      expect(envelope).toBeDefined();
      expect(envelope!.ok).toBe(true);
      expect(envelope!.result.file).toBe(
        id === "claude" ? "~/.claude/settings.json" : "~/.codex/hooks.json",
      );
      expect(Array.isArray(envelope!.result.config.hooks.SessionStart)).toBe(
        true,
      );
      expect(envelope!.result.config.hooks.SessionStart).toHaveLength(1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
