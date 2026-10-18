import { createHash } from "node:crypto";
import {
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  writeSync,
  fsyncSync,
  existsSync,
} from "node:fs";

export interface FileProof {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly digest: string;
}
function digest(fd: number): string {
  const hash = createHash("sha256"),
    buffer = Buffer.alloc(65536);
  let offset = 0,
    count: number;
  while ((count = readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest("hex");
}
function proof(path: string, fd: number): FileProof {
  const before = fstatSync(fd, { bigint: true });
  const hash = digest(fd);
  const after = fstatSync(fd, { bigint: true }),
    named = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    named.isSymbolicLink() ||
    before.dev !== named.dev ||
    before.ino !== named.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  )
    throw new Error("Recovery file identity drift");
  return {
    path,
    device: String(before.dev),
    inode: String(before.ino),
    digest: hash,
  };
}
export function inspectRecoveryFile(path: string): FileProof {
  const fd = openSync(path, "r");
  try {
    return proof(path, fd);
  } finally {
    closeSync(fd);
  }
}
function same(a: FileProof, b: FileProof): boolean {
  return (
    a.path === b.path &&
    a.device === b.device &&
    a.inode === b.inode &&
    a.digest === b.digest
  );
}
function aliases(a: FileProof, b: FileProof): boolean {
  return a.device === b.device && a.inode === b.inode;
}

/** Pin approval to source + backup identity; retain an independent private copy through commit. */
export async function withRecoveryFence<T>(
  approved: { readonly source: FileProof; readonly backup: FileProof },
  recoveryPath: string,
  harden: (paths: readonly string[]) => Promise<void>,
  commit: (verify: () => void) => T,
): Promise<T> {
  const opened: number[] = [];
  try {
    await harden([approved.backup.path]);
    const source = openSync(approved.source.path, "r");
    opened.push(source);
    const backup = openSync(approved.backup.path, "r");
    opened.push(backup);
    if (
      !same(proof(approved.source.path, source), approved.source) ||
      !same(proof(approved.backup.path, backup), approved.backup) ||
      aliases(approved.source, approved.backup)
    )
      throw new Error("Approved recovery inputs changed");
    const recovery = openSync(recoveryPath, "wx+", 0o600);
    opened.push(recovery);
    await harden([recoveryPath]);
    const buffer = Buffer.alloc(65536);
    let offset = 0,
      count: number;
    while ((count = readSync(backup, buffer, 0, buffer.length, offset)) > 0) {
      let written = 0;
      while (written < count) {
        const progress = writeSync(
          recovery,
          buffer,
          written,
          count - written,
          offset + written,
        );
        if (progress <= 0) throw new Error("Recovery copy made no progress");
        written += progress;
      }
      offset += count;
    }
    fsyncSync(recovery);
    const retained = proof(recoveryPath, recovery);
    if (
      retained.digest !== approved.backup.digest ||
      aliases(retained, approved.backup) ||
      aliases(retained, approved.source)
    )
      throw new Error("Independent recovery copy required");
    const verify = (): void => {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        if (existsSync(`${approved.backup.path}${suffix}`))
          throw new Error("Recovery backup has sidecars");
        const sidecar = `${approved.source.path}${suffix}`;
        if (
          existsSync(sidecar) &&
          aliases(inspectRecoveryFile(sidecar), approved.backup)
        )
          throw new Error("Recovery backup aliases a source sidecar");
      }
      if (
        !same(proof(approved.source.path, source), approved.source) ||
        !same(proof(approved.backup.path, backup), approved.backup) ||
        !same(proof(recoveryPath, recovery), retained)
      )
        throw new Error("Recovery fence drift before commit");
    };
    verify();
    const result = commit(verify);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result
    )
      throw new Error("Recovery commit must be synchronous");
    return result;
  } finally {
    for (const fd of opened.reverse()) closeSync(fd);
  }
}
