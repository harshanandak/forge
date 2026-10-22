import { lstatSync } from "node:fs";
import type { PrivateFiles } from "../../ports/private-files.ts";
import { sddlTrustees } from "./private-acl.ts";

export interface PrivateFileGuard {
  directory(path: string): void;
  file(path: string): void;
}

/** Cache only the same file identity and change time, for this store lifetime. */
export function privateFileGuard(native: PrivateFiles): PrivateFileGuard {
  const checked = new Map<string, string>();
  const fail = (path: string): never => {
    throw new Error(
      `Private ACL refused: ${path}; remove unexpected ACL entries and grant only the current user full control before retrying`,
    );
  };
  function verify(path: string, directory: boolean): void {
    const info = lstatSync(path, { bigint: true });
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile()) ||
      (!directory && info.nlink !== 1n)
    )
      fail(path);
    const key = `${info.dev}:${info.ino}:${info.ctimeNs}`;
    if (checked.get(path) === key) return;
    const entry = `(A;OICI;FA;;;${native.sid})`;
    const trustees = sddlTrustees(native.sid).join("|");
    const privateAcl = (sddl: string): boolean =>
      new RegExp(
        `^D:${directory ? "P(?:AI)?" : "(?:P)?(?:AI)?"}\\(A;${directory ? "OICI" : "(?:ID)?"};FA;;;(?:${trustees})\\)$`,
      ).test(sddl);
    try {
      if (!privateAcl(native.read(path))) {
        if (!directory) fail(path);
        native.protect(path, `D:P${entry}`);
        if (!privateAcl(native.read(path))) fail(path);
      }
      const after = lstatSync(path, { bigint: true });
      if (after.dev !== info.dev || after.ino !== info.ino) fail(path);
      checked.set(path, `${after.dev}:${after.ino}:${after.ctimeNs}`);
    } catch (error) {
      throw new Error(
        `Private ACL verification failed for ${path}; fix its owner-only permissions before retrying`,
        { cause: error },
      );
    }
  }
  return {
    directory: (path) => verify(path, true),
    file: (path) => verify(path, false),
  };
}
