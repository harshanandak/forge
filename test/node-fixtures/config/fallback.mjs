import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly, localCall } from "../../../dist/src/assembly/index.js";
import { yamlConfigCodec } from "../../../dist/src/adapters/config-yaml/index.js";
import { dispatch } from "../../../dist/src/surface/dispatch.js";

const root = mkdtempSync(join(tmpdir(), "forge-config-fallback-"));
mkdirSync(join(root, ".forge"));
writeFileSync(
  join(root, ".forge/config.yaml"),
  "blocks:\n  check:\n    commands: {} # original\n",
);
const assembly = await createAssembly({
  root,
  deviceRoot: join(root, "device"),
});
const edit = yamlConfigCodec.edit;
const call = (op, input = {}) =>
  dispatch(assembly.catalog, op, input, localCall(assembly));
try {
  const before = await call("config.show");
  assert.equal(before.ok, true);
  yamlConfigCodec.edit = () => {
    throw new Error("injected CST failure");
  };
  const applied = await call("config.apply", {
    expectRevision: before.result.revision,
    patch: [{ op: "set", path: "check.timeoutMs", value: 1234 }],
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.warnings, [
    {
      code: "CONFIG_FORMATTING_LOST",
      message:
        ".forge/config.yaml: formatting could not be preserved; using whole-document serialization",
    },
  ]);
  const shown = await call("config.show");
  assert.equal(shown.ok, true);
  assert.equal(shown.result.effective.blocks.check.config.timeoutMs, 1234);
  assert.deepEqual(shown.warnings, [], "warnings belong to one call");
  assert.match(
    readFileSync(join(root, ".forge/config.yaml"), "utf8"),
    /timeoutMs: 1234/,
  );
  cpSync(
    fileURLToPath(new URL("../../../examples/hello-block", import.meta.url)),
    join(root, "hello"),
    { recursive: true },
  );
  const added = await call("block.add", { path: "./hello" });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.deepEqual(added.warnings, applied.warnings);
  assert.deepEqual(
    (await call("config.show")).warnings,
    [],
    "warnings belong to one call",
  );
  console.log(
    "PASS config fallback: persisted planned values, file warning, call-local warnings",
  );
} finally {
  yamlConfigCodec.edit = edit;
  await assembly.close();
  rmSync(root, { recursive: true, force: true });
}
