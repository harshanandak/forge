import { expect, test } from "bun:test";
import { resolveComposition } from "../../../src/contract/composition.ts";
import type { ConfigDocument } from "../../../src/generated/types.ts";
import { createConfig } from "../../../src/core/config/config.ts";
import { firstPartyManifests } from "../../contract/lib/fixtures.ts";
import { failureOf, makeProject } from "./lib/project.ts";

test("config apply refuses an unknown bind key without changing valid binds", () => {
  const project = makeProject();
  try {
    const manifests = firstPartyManifests();
    const config = createConfig({
      ...project.env,
      blockManifest: (name) => {
        const manifest = manifests.get(name);
        if (manifest === undefined) throw new Error(`missing fixture ${name}`);
        return manifest;
      },
    });
    config.apply({
      expectRevision: config.show().revision,
      patch: [
        {
          op: "set",
          path: "/blocks",
          value: {
            context: {
              source: { builtin: "forge/context" },
              bind: { tracker: "work" },
            },
            work: { source: { builtin: "forge/work" } },
          },
        },
      ],
    });
    const before = project.read();
    const shown = config.show();
    const composed = resolveComposition(
      shown.effective as unknown as ConfigDocument,
      manifests,
    );
    expect(composed.ok).toBe(true);
    const problem = failureOf(() =>
      config.set({
        expectRevision: shown.revision,
        path: "/blocks/context/bind/trackr",
        value: "work",
      }),
    );
    expect(problem).toMatchObject({
      code: "INPUT_INVALID",
      pointer: "/blocks/context/bind/trackr",
    });
    expect(problem?.message).toContain("tracker");
    expect(project.read()).toBe(before);
    expect(config.show().effective).toEqual(shown.effective);
    expect(
      resolveComposition(
        config.show().effective as unknown as ConfigDocument,
        manifests,
      ),
    ).toEqual(composed);
  } finally {
    project.cleanup();
  }
}, 5000);
