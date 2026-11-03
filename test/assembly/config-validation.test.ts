import { expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";

setDefaultTimeout(30_000);

for (const record of [{}, null]) {
  test(`show diagnoses invalid template record ${JSON.stringify(record)} and explain excludes it`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-invalid-template-"));
    mkdirSync(join(root, ".forge"));
    const file = join(root, ".forge/config.yaml");
    const text = JSON.stringify({ blocks: {}, templates: [record] });
    writeFileSync(file, text);
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
      providers: { env: {} },
    });
    try {
      const shown = await runCli(
        assembly.catalog,
        ["config", "show"],
        localCall(assembly),
      );
      expect(shown.envelope).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
      if (shown.envelope.ok) throw new Error("Expected invalid config");
      expect(shown.envelope.error.message).toContain("templates.0");
      const explained = await runCli(
        assembly.catalog,
        ["config", "explain", "--input", '{"path":"/templates/0"}'],
        localCall(assembly),
      );
      expect(explained.envelope).toMatchObject({
        ok: true,
        result: { set: false, value: null, entries: [] },
      });
      expect(readFileSync(file, "utf8")).toBe(text);
    } finally {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("show refuses invocation removes at op while sets and patch removes still work", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-invocation-ops-"));
  mkdirSync(join(root, ".forge"));
  const file = join(root, ".forge/config.yaml");
  const text = JSON.stringify({ blocks: {}, values: { greeting: "saved" } });
  writeFileSync(file, text);
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
  });
  const call = async (verb: string, input: unknown) =>
    (
      await runCli(
        assembly.catalog,
        ["config", verb, "--input", JSON.stringify(input)],
        localCall(assembly),
      )
    ).envelope;
  try {
    const refused = await call("show", {
      invocation: [{ op: "remove", path: "/blocks/check" }],
    });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "INPUT_INVALID",
      },
    });
    if (refused.ok) throw new Error("Expected invalid invocation op");
    expect(refused.error.observed).toHaveProperty(
      "problems.0.pointer",
      "/invocation/0/op",
    );
    expect(refused.error.message).toContain("invocation[0].op");
    expect(readFileSync(file, "utf8")).toBe(text);

    const shown = await call("show", {
      invocation: [{ op: "set", path: "/values/greeting", value: "temporary" }],
    });
    expect(shown).toMatchObject({
      ok: true,
      result: { valid: true, effective: { values: { greeting: "temporary" } } },
    });
    expect(readFileSync(file, "utf8")).toBe(text);
    const revision = (shown.result as { revision: string }).revision;
    const set = await call("set", {
      path: "/values/greeting",
      value: "updated",
      expectRevision: revision,
    });
    expect(set.ok).toBe(true);
    const patch = [{ op: "remove", path: "/values/greeting" }];
    expect(await call("preview", { patch })).toMatchObject({
      ok: true,
      result: { valid: true },
    });
    expect(
      await call("apply", {
        patch,
        expectRevision: (set.result as { revision: string }).revision,
      }),
    ).toMatchObject({ ok: true });
    const after = await call("show", {});
    expect(after.ok).toBe(true);
    expect(after.result).not.toHaveProperty("effective.values.greeting");
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
});
