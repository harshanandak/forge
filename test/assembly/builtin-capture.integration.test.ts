import { expect, spyOn, test } from "bun:test";
import {
  realpathSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { blockCapture } from "../../src/assembly/capture.ts";
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";

test("a registered built-in with a missing entry returns path-free repair guidance", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-builtin-")));
  const checkout = join(root, "checkout");
  const install = join(root, "private-install-sentinel");
  mkdirSync(join(checkout, ".forge"), { recursive: true });
  writeFileSync(
    join(checkout, ".forge/config.yaml"),
    "blocks:\n  memory: {}\n",
  );
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) => {
    const handle = open(path);
    if (basename(path) !== "memory") return handle;
    return {
      ...handle,
      value: {
        ...handle.value,
        read(name, budget) {
          if (name.endsWith(".cjs")) realpathSync(join(install, name));
          return handle.value.read(name, budget);
        },
      },
    };
  });
  const assembly = await createAssembly({
    root: checkout,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
  });
  try {
    const result = await runCli(
      assembly.catalog,
      ["memory", "search", "probe"],
      {
        caller: "human",
        context: localContext(assembly, { kind: "human", id: "test" }),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_MISSING" },
    });
    expect(result.stdout.includes("private-install-sentinel")).toBe(false);
    expect(result.stdout).toContain("Repair or reinstall Forge");
    const [unavailable] = assembly.catalog.unavailable();
    expect(unavailable?.error).toMatchObject({
      code: "PROVIDER_MISSING",
      message:
        "Built-in block could not be prepared. Repair or reinstall Forge.",
    });
  } finally {
    await assembly.close();
    capture.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
