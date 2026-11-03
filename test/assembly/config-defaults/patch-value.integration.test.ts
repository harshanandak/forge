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
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import { runCli } from "../../../src/surface/cli.ts";

setDefaultTimeout(30_000);

test("every patch consumer refuses a set without value at the missing field", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-patch-value-"));
  mkdirSync(join(root, ".forge"));
  const file = join(root, ".forge/config.yaml");
  const before = JSON.stringify({ blocks: {}, values: { greeting: "keep" } });
  writeFileSync(file, before);
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
    const shown = await call("show", {});
    expect(shown.ok).toBe(true);
    const { revision } = shown.result as { revision: string };
    for (const verb of ["show", "preview", "apply"]) {
      const key = verb === "show" ? "invocation" : "patch";
      const input = {
        [key]: [{ op: "set", path: "/values/greeting" }],
        ...(verb === "apply" ? { expectRevision: revision } : {}),
      };
      expect(await call(verb, input)).toMatchObject({
        ok: false,
        error: {
          code: "INPUT_INVALID",
          observed: {
            problems: [{ pointer: `/${key}/0/value`, keyword: "required" }],
          },
        },
      });
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(
        await call(verb, {
          ...input,
          [key]: [{ op: "set", path: "/values/greeting", value: null }],
        }),
      ).toMatchObject({ ok: true });
      if (verb !== "apply") expect(readFileSync(file, "utf8")).toBe(before);
    }
    expect(
      await call("preview", {
        patch: [{ op: "remove", path: "/values/greeting" }],
      }),
    ).toMatchObject({ ok: true });
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
});
