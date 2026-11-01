import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResultEnvelope } from "../../../src/generated/types.ts";

const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");

test("integration: built CLI loads moved project notes and resolves old ids once", () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required");
  const root = mkdtempSync(join(tmpdir(), "forge-moved-"));
  const project = join(root, "forge-new");
  const outside = join(root, "outside");
  const device = join(root, "device");
  const env = {
    ...process.env,
    FORGE_DEVICE_ROOT: device,
    FORGE_DEVICE_ID: "moved-test",
    FORGE_SESSION: "moved-test",
  };
  try {
    mkdirSync(join(project, ".forge"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(
      join(project, "package.json"),
      '{"name":"moved-test","private":true}',
    );
    writeFileSync(
      join(project, ".forge/config.yaml"),
      "schemaVersion: forge.config/1\nblocks:\n  memory:\n    source:\n      builtin: forge/memory\n",
    );
    const git = spawnSync("git", ["init", "--quiet"], {
      cwd: project,
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    expect(git.status, git.stderr).toBe(0);
    // Confirm Node sees the temporary root before the first memory write.
    const checked = spawnSync(
      node,
      ["-e", "console.log(process.env.FORGE_DEVICE_ROOT)"],
      {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    console.log(`FORGE_DEVICE_ROOT=${checked.stdout.trim()}`);
    expect(checked.status).toBe(0);
    expect(checked.stdout.trim()).toBe(device);
    function cli(verb: string, input: object, cwd = project): unknown {
      const run = spawnSync(
        node!,
        [bin, "memory", verb, "--input", JSON.stringify(input)],
        { cwd, env, encoding: "utf8", timeout: 30_000, windowsHide: true },
      );
      expect(run.status, run.stderr || run.stdout).toBe(0);
      const result = JSON.parse(run.stdout) as ResultEnvelope;
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.result;
    }
    const old = cli("add", {
      level: "device",
      scope: "forge",
      text: "moved rule",
      tags: ["rule", "on:deploy"],
    }) as { id: string };
    const foreign = cli("add", {
      level: "device",
      scope: "other",
      text: "foreign rule",
      tags: ["rule", "on:deploy"],
    }) as { id: string };
    const moved = cli("move", {
      id: old.id,
      to: "project",
      expectRevision: 1,
    }) as { to: string };
    expect(cli("scope", {})).toEqual({ scope: "forge-new" });
    const rules = cli("rules", {}) as { text: { text: string } };
    expect(rules.text.text).toContain("forge-new 1");
    const start = cli("rules", { notes: true }) as { text: { text: string } };
    expect(start.text.text).toContain("moved rule");
    expect(start.text.text).not.toContain("foreign rule");
    for (const ids of [[moved.to], [old.id], [old.id, moved.to]]) {
      const attached = cli("attach", { ids }) as {
        receipt: { selected: { id: string; movedFrom?: string }[] };
      };
      expect(attached.receipt.selected).toHaveLength(1);
      expect(attached.receipt.selected[0]!.id).toBe(moved.to);
      if (ids.includes(old.id))
        expect(attached.receipt.selected[0]!.movedFrom).toBe(old.id);
      expect(
        cli("attach", { ids, seen: attached.receipt.selected }),
      ).toMatchObject({
        receipt: {
          selected: [],
          omitted: [{ id: moved.to, reason: "seen" }],
        },
      });
    }
    const shown = cli("show", { id: old.id });
    expect(shown).toMatchObject({
      status: "found",
      note: {
        id: moved.to,
        movedFrom: old.id,
        scope: "forge",
        text: { text: "moved rule" },
      },
    });
    const pointer = cli("show", { id: old.id }, outside) as { next: string };
    expect(pointer).toMatchObject({ status: "moved", to: moved.to });
    expect(pointer.next).toContain(moved.to.split("/")[1]!);
    const second = cli("add", { level: "device", text: "second moved" }) as {
      id: string;
    };
    cli("move", { id: second.id, to: "project", expectRevision: 1 });
    const unresolved = cli(
      "attach",
      { ids: [second.id, old.id, second.id] },
      outside,
    ) as { receipt: { moved: { id: string }[] } };
    expect(unresolved.receipt.moved.map((note) => note.id)).toEqual([
      second.id,
      old.id,
    ]);
    const linker = cli("add", {
      level: "device",
      text: "linker",
      links: [old.id],
    }) as { id: string };
    const links = cli("show", { id: linker.id }) as {
      note: { links: string[] };
    };
    expect(links.note.links).toEqual([old.id]);
    expect(cli("show", { id: links.note.links[0] })).toEqual(shown);
    expect(
      JSON.stringify(cli("attach", { ids: [foreign.id], labels: ["deploy"] })),
    ).not.toContain("foreign rule");
    const back = cli("move", {
      id: moved.to,
      to: "device",
      expectRevision: 1,
    }) as { to: string };
    expect(cli("show", { id: old.id })).toMatchObject({
      status: "moved",
      to: back.to,
    });
    expect(cli("attach", { ids: [old.id] })).toMatchObject({
      receipt: { selected: [], moved: [{ to: back.to }] },
    });
    console.log(
      "PASS moved rules, start packet, attach by both ids, show, no-project pointer, links, one-hop limit, device filter",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
