import { lstatSync, type BigIntStats } from "node:fs";
import { pathToFileURL } from "node:url";

const nanosecondsPerSecond = 1_000_000_000n;

function hasSidecar(path: string): boolean {
  return ["-wal", "-shm", "-journal"].some((suffix) =>
    lstatSync(path + suffix, { throwIfNoEntry: false }),
  );
}

export function probeHubSchema(
  path: string,
  before: BigIntStats,
  inspect: (filename: string) => 0 | 1,
  macOSBun = process.platform === "darwin" && Boolean(process.versions.bun),
): 0 | 1 {
  if (
    !macOSBun ||
    (before.mtimeNs % nanosecondsPerSecond === 0n &&
      before.ctimeNs % nanosecondsPerSecond === 0n) ||
    hasSidecar(path)
  )
    return inspect(path);

  const uri = pathToFileURL(path);
  uri.searchParams.set("immutable", "1");
  const version = inspect(uri.href);
  const after = lstatSync(path, { bigint: true });
  if (
    !after.isFile() ||
    after.nlink !== 1n ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs ||
    hasSidecar(path)
  )
    throw new Error("Hub database changed during schema inspection");
  return version;
}
