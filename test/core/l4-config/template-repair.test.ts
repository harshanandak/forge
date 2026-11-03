import { expect, test } from "bun:test";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { makeProject, starter } from "./lib/project.ts";

test("removing a template that supplied required commands gets template-specific advice", () => {
  const project = makeProject({
    configSchema: (name) =>
      name === "check"
        ? {
            type: "object",
            required: ["commands"],
            properties: {
              commands: { type: "object" },
              timeoutMs: { type: "number" },
            },
          }
        : undefined,
  });
  try {
    project.installed.set("forge/required", {
      ...starter(),
      id: "forge/required",
      config: {
        schemaVersion: "forge.config/1",
        blocks: {
          check: {
            source: { builtin: "forge/check" },
            config: { commands: { test: "node --test" } },
          },
        },
      },
    });
    const imported = project.templates.importTemplate({
      template: "forge/required",
    });
    const edited = project.config.set({
      path: "check.timeoutMs",
      value: 1000,
      expectRevision: imported.revision,
    });
    const original = project.read();
    let failure: unknown;
    try {
      project.templates.remove({
        template: "forge/required",
        expectRevision: edited.revision,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ForgeFailure);
    if (!(failure instanceof ForgeFailure))
      throw new Error("expected a missing-value refusal");
    expect(failure.error.pointer).toBe("/blocks/check/config/commands");
    expect(failure.error.repair).toContain("forge config set --input ");
    expect(failure.error.repair).toContain(
      "retry template remove at the new revision",
    );
    expect(failure.error.repair).not.toContain("in the same edit");
    expect(project.read()).toBe(original);
  } finally {
    project.cleanup();
  }
}, 30_000);
