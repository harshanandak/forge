// Runs under Node (not Bun): the L4 journey through the real core sources, the real YAML adapter and
// the real file system, printing one JSON line of outcomes for test/core/l4-config/node-journey.test.ts.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfigFiles } from "../../../src/adapters/fs/index.ts";
import { yamlConfigCodec } from "../../../src/adapters/config-yaml/index.ts";
import type { TemplateDocument } from "../../../src/contract/index.ts";
import {
  createConfig,
  createTemplates,
  type TemplateEnvironment,
} from "../../../src/core/config/index.ts";

const here = import.meta.dirname;
const json = (path: string): unknown =>
  JSON.parse(readFileSync(join(here, path), "utf8"));
const templates = new Map(
  ["forge-delivery", "forge-starter"].map((name) => {
    const t = json(
      `../../contract/fixtures/templates/${name}.json`,
    ) as TemplateDocument;
    return [t.id, t] as const;
  }),
);
const root = mkdtempSync(join(tmpdir(), "forge-l4-node-"));
try {
  const env: TemplateEnvironment = {
    files: nodeConfigFiles(root),
    codec: yamlConfigCodec,
    clock: { now: () => Date.UTC(2026, 9, 18) },
    detect: () => json("npm-project.detections.json") as unknown[],
    templates: {
      list: () => [...templates.values()],
      get: (id) => templates.get(id),
    },
    builtinSource: (name) => ({ builtin: `forge/${name}` }),
  };
  const config = createConfig(env);
  const lifecycle = createTemplates(env);
  const outcome = (call: () => unknown): string => {
    try {
      call();
      return "OK";
    } catch (error) {
      return (
        (error as { error?: { code?: string } }).error?.code ?? String(error)
      );
    }
  };

  const adaptive = config.show();
  const first = config.set({
    path: "check.commands.test",
    value: "pnpm vitest run",
    expectRevision: adaptive.revision,
  });
  const stale = outcome(() =>
    config.set({
      path: "check.commands.test",
      value: "x",
      expectRevision: adaptive.revision,
    }),
  );
  const overridden = config.explain({ path: "check.commands.test" });
  const unknown = outcome(() =>
    config.set({
      path: "/blocks/check/sorce",
      value: 1,
      expectRevision: first.revision,
    }),
  );
  config.revert({ expectRevision: first.revision });

  mkdirSync(join(root, ".forge"), { recursive: true });
  const handWritten = "# mine\nschemaVersion: forge.config/1\nblocks: {}\n";
  writeFileSync(join(root, ".forge/config.yaml"), handWritten);
  const handRevision = config.show().revision;
  const d = lifecycle.import({
    template: "forge/delivery",
    expectRevision: handRevision,
  });
  const s = lifecycle.import({
    template: "forge/starter",
    expectRevision: d.revision,
  });
  const edit = config.set({
    path: "pr.merge.settleMinutes",
    value: 15,
    expectRevision: s.revision,
  });
  const r1 = lifecycle.remove({
    template: "forge/delivery",
    expectRevision: edit.revision,
  });
  const kept = config.explain({ path: "pr.merge.settleMinutes" }).value;
  const r2 = lifecycle.remove({
    template: "forge/starter",
    expectRevision: r1.revision,
  });
  const left = config.show().instances.map((i) => i.name);
  const r3 = config.apply({
    patch: [{ op: "remove", path: "/blocks/pr" }],
    expectRevision: r2.revision,
  });
  const back = config.show();

  console.log(
    JSON.stringify({
      runtime:
        typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
          ? "node"
          : "bun",
      adaptive: {
        configured: adaptive.configured,
        instances: adaptive.instances.length,
        values: adaptive.values.length,
      },
      stale,
      overridden: [
        overridden.layer,
        overridden.entries.map((e) => `${e.layer}:${e.active}`),
      ],
      unknown,
      revertedToNothing: config.show().configured === false,
      kept,
      left,
      backToAdaptive:
        r3.fileRemoved &&
        back.configured === false &&
        back.values.length === adaptive.values.length,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
