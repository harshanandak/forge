import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("built accounts handler has no imports for its isolated runtime", () => {
  const path = resolve(
    import.meta.dirname,
    "../../../dist/src/blocks/accounts/entry.cjs",
  );
  const source = readFileSync(path, "utf8");
  expect(new Bun.Transpiler({ loader: "js" }).scan(source).imports).toEqual([]);
}, 30_000);
