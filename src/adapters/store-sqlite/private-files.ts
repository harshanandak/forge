import { lstatSync } from "node:fs";
import type { PrivateFiles } from "../../ports/private-files.ts";
import { sddlTrustees } from "./private-acl.ts";

export interface PrivateFileGuard {
  directory(path: string): void;
  file(path: string): void;
}

/** Windows can change a DACL without changing stat times; always read it natively. */
export function privateFileGuard(native: PrivateFiles): PrivateFileGuard {
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
    } catch (error) {
      const literal = `'${path.replaceAll("'", "''")}'`;
      const descriptor = `D:P(A;${directory ? "OICI" : ""};FA;;;${native.sid})`;
      const repair = `$acl = New-Object System.Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}; $acl.SetSecurityDescriptorSddlForm('${descriptor}', [System.Security.AccessControl.AccessControlSections]::Access); [System.IO.${directory ? "Directory" : "File"}]::SetAccessControl(${literal}, $acl)`;
      throw new Error(
        `Private ACL verification failed for ${path}. Stop Forge connections, then repair and retry. Repair in PowerShell: ${repair}`,
        { cause: error },
      );
    }
  }
  return {
    directory: (path) => verify(path, true),
    file: (path) => verify(path, false),
  };
}
