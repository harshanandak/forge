import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { selectSourceFiles } from "./source-selection.ts";

// Timings are whole-file milliseconds; unmeasured files get one second.
export function assignShards(
  files: string[],
  timings: Record<string, number>,
  count: number,
): string[][] {
  const shards = Array.from({ length: count }, () => [] as string[]);
  const loads = Array<number>(count).fill(0);
  const weight = (file: string) => timings[file] ?? 1000;
  for (const file of files.toSorted(
    (a, b) => weight(b) - weight(a) || a.localeCompare(b),
  )) {
    const index = loads.indexOf(Math.min(...loads));
    shards[index]!.push(file);
    loads[index]! += weight(file);
  }
  return shards;
}

if (import.meta.main) {
  const [suite, shard, ...options] = process.argv.slice(2);
  const mode = options.includes("--list") ? "--list" : undefined;
  const [index, count] = (shard ?? "").split("/").map(Number);
  if (
    !/^test:(unit|integration)$/.test(suite ?? "") ||
    !index ||
    !count ||
    index > count
  )
    throw new Error("expected suite and shard index/count");
  const { files: timings } = JSON.parse(
    readFileSync("test/timings.json", "utf8"),
  ) as { files: Record<string, number> };
  const files = [...new Bun.Glob("{test,src}/**/*.test.ts").scanSync(".")]
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith("/packed.integration.test.ts"));
  const selectedFiles = selectSourceFiles(
    files,
    options.includes("--node26") ? "26" : "24",
  );
  const assigned = assignShards(selectedFiles, timings, count)[index - 1]!;
  console.log(
    `Source selection: ${selectedFiles.length}/${files.length} files, shard ${shard}`,
  );
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  // Parse the existing scripts so phase exclusions and serial membership stay authoritative.
  for (const command of scripts[suite!]!.split(" && ")) {
    if (command === "bun run build") {
      if (mode !== "--list") run(["run", "build"]);
      continue;
    }
    const ignore = /--path-ignore-patterns '([^']+)'/.exec(command);
    const glob = ignore ? new Bun.Glob(ignore[1]!) : undefined;
    const explicit = command.match(/test\/\S+\.test\.ts/g);
    const selected = assigned.filter((file) =>
      explicit
        ? explicit.includes(file)
        : !glob?.match(file) &&
          (suite === "test:unit" || file.endsWith(".integration.test.ts")),
    );
    if (mode === "--list") console.log(JSON.stringify(selected));
    else if (selected.length)
      run([
        "test",
        ...command
          .match(/--parallel|--timeout \d+/g)!
          .flatMap((arg) => arg.split(" ")),
        ...(process.env.CI_TIMINGS
          ? [`--timings=${process.env.CI_TIMINGS}`, "--update-timings"]
          : []),
        ...selected.map((file) => `./${file}`),
      ]);
  }
}
