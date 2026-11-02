import { hash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { packInput } from "../pack-smoke/input.ts";

const run = (args: string[], stdin?: Uint8Array): string => {
  const result = Bun.spawnSync(args, {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0)
    throw new Error(`${args[0]} failed (${result.exitCode})`);
  return result.stdout.toString();
};

export async function dryRun(
  input: string,
  io: {
    run: (args: string[], stdin?: Uint8Array) => string;
    fetch: (url: string) => Promise<Response>;
    requireRegistry?: boolean;
  },
): Promise<string> {
  const tarball = packInput(input)!;
  const pkg = JSON.parse(
    io.run(
      ["tar", "-xzOf", "-", "package/package.json"],
      readFileSync(tarball),
    ),
  ) as { name: string; version: string };
  if (
    pkg.name !== "forge-workflow" ||
    !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(pkg.version)
  )
    throw new Error("release: invalid forge-workflow package/version");
  const response = await io
    .fetch(
      `https://registry.npmjs.org/forge-workflow/${encodeURIComponent(pkg.version)}`,
    )
    .catch((error: unknown) => {
      if (io.requireRegistry) throw error;
      console.warn(
        "release: offline; skipped registry version check (local dry-run only)",
      );
      return undefined;
    });
  if (response?.ok)
    throw new Error(`release: ${pkg.version} already published`);
  if (response && response.status !== 404)
    throw new Error(`release: registry HTTP ${response.status}`);
  const flags =
    "--dry-run --provenance --tag next --access public --ignore-scripts";
  console.log(io.run(["npm", "publish", tarball, ...flags.split(" ")]));
  return pkg.version;
}

if (import.meta.main) {
  try {
    if (!process.argv[2])
      throw new Error("Usage: bun run release:dry-run <tarball>");
    const version = await dryRun(process.argv[2], {
      run,
      fetch: (url) => fetch(url, { signal: AbortSignal.timeout(10_000) }),
      requireRegistry: process.env.CI === "true",
    });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${version}\nsha256=${hash("sha256", readFileSync(process.argv[2]))}\n`,
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
