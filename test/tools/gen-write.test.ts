import { expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writeCoreManifest } from "../../tools/gen/core.ts";
import { preload } from "../../tools/gen/preload.ts";
import { OUTPUTS, write } from "../../tools/gen/types.ts";

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

test("concurrent writers publish identical complete content", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-gen-race-"));
  const file = join(root, "out", "output.txt");
  const source = join(root, "source.txt");
  const content = "generated content\n".repeat(10_000);
  const script = new URL("../../tools/gen/write.ts", import.meta.url).href;
  const command = `import { readFileSync } from "node:fs"; import { writeGenerated } from ${JSON.stringify(script)}; writeGenerated(process.argv[1], readFileSync(process.argv[2], "utf8"));`;
  try {
    writeFileSync(source, content);
    await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["-e", command, file, source],
              { stdio: "pipe" },
            );
            let stderr = "";
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk: string) => {
              stderr += chunk;
            });
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0
                ? resolve()
                : reject(new Error(stderr || `writer exited ${code}`)),
            );
          }),
      ),
    );
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(readdirSync(join(root, "out"))).toEqual(["output.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
