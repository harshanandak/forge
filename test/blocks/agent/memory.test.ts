import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import {
  type JsonSchema,
  validateWithSchema,
} from "../../../src/contract/schema.ts";

const module = { exports: {} };
runInNewContext(
  new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(
      resolve(import.meta.dirname, "../../../src/blocks/agent/entry.cts"),
      "utf8",
    ),
  ),
  {
    module,
    fail: (code: string, message: string) => {
      throw new Error(`${code}: ${message}`);
    },
  },
);
const entry = module.exports as Record<
  string,
  (call: unknown) => {
    file?: string;
    instruction: string;
    config?: {
      hooks: Record<
        string,
        { hooks: { type: string; command: string; timeout: number }[] }[]
      >;
    };
  }
>;
const adapter = {
  id: "custom",
  detect: ["CUSTOM"],
  memory: { kind: "hook", file: "~/custom/hooks.json", start: "CustomStart" },
};
const call = (
  input = {},
  adapters = [adapter],
  env: Record<string, string> = { CUSTOM: "1" },
) => ({
  input,
  config: { adapters },
  services: {
    environment: {
      packageRoot: "C:\\Forge install",
      platform: "win32",
      select: (names: readonly string[]) =>
        Object.fromEntries(
          names
            .filter((name) => env[name] !== undefined)
            .map((name) => [name, env[name]!]),
        ),
    },
  },
});

test("memory operation exists and renders a data-driven SessionStart hook without a matcher", () => {
  expect(typeof entry["agent.memory"]).toBe("function");
  for (const input of [{}, { id: "custom" }]) {
    const result = entry["agent.memory"]!(call(input));
    expect(result.file).toBe("~/custom/hooks.json");
    expect(result.instruction).toMatch(/merge.*preserv/i);
    expect(result.config).toEqual({
      hooks: {
        CustomStart: [
          {
            hooks: [
              {
                type: "command",
                command:
                  'node "C:/Forge install/templates/delivery/harness/memory-start.mjs"',
                timeout: 20,
              },
            ],
          },
        ],
      },
    });
  }
}, 30_000);

test("memory capability is schema-declared and rejects incomplete hooks and extra fields", () => {
  const schema = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../../src/blocks/agent/schemas/adapter.json",
      ),
      "utf8",
    ),
  ) as JsonSchema;
  expect(validateWithSchema(schema, adapter)).toEqual([]);
  for (const memory of [
    { kind: "hook", file: "x" },
    { kind: "hook", file: "x", start: "Start", extra: true },
    { kind: "none", file: "x" },
  ])
    expect(validateWithSchema(schema, { ...adapter, memory })).not.toEqual([]);
}, 30_000);

test("memory operation gives nonhook adapters an underlying-harness pointer", () => {
  expect(typeof entry["agent.memory"]).toBe("function");
  const plain = { id: "plain", detect: [] };
  const result = entry["agent.memory"]!({
    ...call({ id: "plain" }),
    config: { adapters: [plain] },
  });
  expect(result.config).toBeUndefined();
  expect(result.instruction).toMatch(/underlying harness/i);
  expect(result.instruction).not.toContain("\n");
}, 30_000);

test("T3 delegates memory setup to the underlying harness despite inherited capabilities", () => {
  expect(typeof entry["agent.memory"]).toBe("function");
  const t3 = { id: "t3", detect: ["T3"], over: ["custom"] };
  const result = entry["agent.memory"]!({
    ...call({}, [adapter], { CUSTOM: "1", T3: "1" }),
    config: { adapters: [t3, adapter] },
  });
  expect(result.config).toBeUndefined();
  expect(result.instruction).toMatch(/underlying harness/i);
}, 30_000);

test("memory rejects unknown adapters and unsafe installed companion paths", () => {
  expect(typeof entry["agent.memory"]).toBe("function");
  expect(() => entry["agent.memory"]!(call({ id: "unknown" }))).toThrow(
    "INPUT_INVALID: Unknown agent unknown",
  );
  for (const character of ["$", "`", '"', "'", "%", "!", "\n", "\r", "\0"]) {
    const fixture = call();
    fixture.services.environment.packageRoot = `C:/Forge ${character} install`;
    expect(() => entry["agent.memory"]!(fixture)).toThrow("INPUT_INVALID");
  }
}, 30_000);
