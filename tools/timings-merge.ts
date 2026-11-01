import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run-command.ts";

const work = mkdtempSync(join(tmpdir(), "forge-timings-"));
try {
  const run = process.argv[2] ?? "";
  if (!/^[1-9]\d*$/.test(run) || process.argv.length !== 3)
    throw new Error("Usage: bun tools/timings-merge.ts <run-id>");
  const user = process.env.FORGE_GH_USER;
  if (!user) throw new Error("FORGE_GH_USER must name the GitHub account");
  const gh = (args: string[], token?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: "github.com" };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    if (token) env.GH_TOKEN = token;
    const result = runCommand("gh", args, {
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (result.error || result.status !== 0)
      throw new Error(`gh ${args[0]} ${args[1]} failed`);
    return result.stdout.trim();
  };
  const token = gh(["auth", "token", "--user", user]);
  if (!token) throw new Error("gh auth token returned no token");
  gh(
    ["run", "download", run, "--pattern", "windows-timings-*", "--dir", work],
    token,
  );
  // Maximum across Node 24/26 balances for the slower supported Windows runtime.
  const files: Record<string, number> = {};
  for (const node of [24, 26])
    for (const shard of [1, 2, 3])
      for (const suite of ["unit", "parallel", "serial"]) {
        const name = `windows-timings-node-${node}-shard-${shard}`;
        const artifact = Bun.file(join(work, name, `timings-${suite}.json`));
        if (!(await artifact.exists()))
          throw new Error(`Missing timing artifact: ${name}/${suite}`);
        const data = (await artifact.json()) as {
          files: Record<string, unknown>;
        };
        for (const [file, ms] of Object.entries(data.files)) {
          if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0)
            throw new Error(`Invalid timing: ${name}: ${file}`);
          files[file] = Math.max(files[file] ?? 0, ms);
        }
      }
  if (!Object.keys(files).length)
    throw new Error("Timing artifacts contain no files");
  const sorted = Object.fromEntries(Object.entries(files).sort());
  await Bun.write(
    "test/timings.json",
    JSON.stringify({ version: 1, files: sorted }, null, 2) + "\n",
  );
  const count = Object.keys(files).length;
  console.log(JSON.stringify({ ok: true, run, files: count }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }));
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
