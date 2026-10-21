import { expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCoreManifest } from "../../tools/gen/core.ts";
import { preload } from "../../tools/gen/preload.ts";
import { OUTPUTS, write } from "../../tools/gen/types.ts";
import { writeGenerated } from "../../tools/gen/write.ts";

/** Fails the first calls with `code`, as Windows does while another writer holds or replaces the file. */
function busy(code: string, times: number) {
  let left = times;
  return <T>(step: () => T): T => {
    if (left > 0) {
      left -= 1;
      throw Object.assign(new Error(`${code}: busy`), { code });
    }
    return step();
  };
}

test.each(["EPERM", "EBUSY", "EACCES"])(
  "a %s read and replace is retried until the write publishes",
  (code) => {
    const directory = mkdtempSync(join(tmpdir(), "forge-gen-busy-"));
    const file = join(directory, "output.txt");
    try {
      writeFileSync(file, "stale");
      const read = busy(code, 3);
      const rename = busy(code, 3);
      const published = writeGenerated(file, "fresh", {
        read: (path) => read(() => readFileSync(path, "utf8")),
        rename: (from, to) => rename(() => renameSync(from, to)),
      });
      expect(published).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("fresh");
      expect(readdirSync(directory)).toEqual(["output.txt"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

const generated = [
  ...Object.values(OUTPUTS),
  "src/generated/core-discovery.ts",
  "src/generated/core-manifest.json",
];

test("preload leaves every current generated output untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-preload-"));
  try {
    // Type generation needs the schema inputs; core generation reads its area declarations from this repo.
    cpSync(new URL("../../schemas/", import.meta.url), join(root, "schemas"), {
      recursive: true,
    });
    write(root);
    writeCoreManifest(root);
    const stale = new Date("2020-01-01T00:00:00Z");
    for (const path of generated) utimesSync(join(root, path), stale, stale);
    await preload(root);
    for (const path of generated)
      expect(statSync(join(root, path)).mtimeMs).toBe(stale.getTime());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
