import { lstatSync } from "node:fs";
import type { PrivateFiles } from "../../ports/private-files.ts";

export interface PrivateFileGuard {
  directory(path: string, created?: boolean): void;
  file(path: string): void;
}

function canRepairFile(
  descriptor: string,
  trustees: readonly string[],
): boolean {
  const body = /^D:[A-Z]*((?:\([^()]*\))*)$/.exec(descriptor)?.[1];
  if (body === undefined) return false;
  const entries = [...body.matchAll(/\(([^()]*)\)/g)].map((match) =>
    match[1]!.split(";"),
  );
  if (
    entries.some(
      (ace) =>
        ace.length !== 6 || ace[0] !== "A" || ace[3] !== "" || ace[4] !== "",
    )
  )
    return false;
  const own = (ace: readonly string[]): boolean => trustees.includes(ace[5]!);
  return entries.some(
    (ace) => own(ace) && ace[2] === "FA" && !ace[1]!.includes("IO"),
  );
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/['\u2018-\u201b]/g, "$&$&")}'`;
}

/** Windows can change a DACL without changing stat times; always read it natively. */
export function privateFileGuard(
  native: PrivateFiles,
  options: { readonly protectDirectories?: boolean } = {},
): PrivateFileGuard {
  const fail = (path: string): never => {
    throw new Error(
      `Private ACL refused: ${path}; remove unexpected ACL entries and grant only the current user full control before retrying`,
    );
  };
  function verify(path: string, directory: boolean, created = false): void {
    const info = lstatSync(path, { bigint: true });
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile()) ||
      (!directory && info.nlink !== 1n)
    )
      fail(path);
    const entry = `(A;OICI;FA;;;${native.sid})`;
    const ownTrustees = [native.sid, ...(native.aliases ?? [])];
    const trustees = ownTrustees.join("|");
    const borrowedDirectory = directory && options.protectDirectories === false;
    const privateAcl = (sddl: string): boolean =>
      new RegExp(
        `^D:${directory && !borrowedDirectory ? "P(?:AI)?" : "(?:P)?(?:AI)?"}\\(A;${directory ? (borrowedDirectory ? "OICI(?:ID)?" : "OICI") : "(?:ID)?"};FA;;;(?:${trustees})\\)$`,
      ).test(sddl);
    try {
      if (!privateAcl(native.read(path))) {
        if (!directory || (options.protectDirectories === false && !created))
          fail(path);
        const before = lstatSync(path, { bigint: true });
        if (before.dev !== info.dev || before.ino !== info.ino) fail(path);
        native.protect(path, `D:P${entry}`);
        if (!privateAcl(native.read(path))) fail(path);
      }
      const after = lstatSync(path, { bigint: true });
      if (after.dev !== info.dev || after.ino !== info.ino) fail(path);
    } catch (error) {
      const prefix = `Private ACL verification failed for ${path}.`;
      if (directory)
        throw new Error(
          options.protectDirectories === false
            ? `${prefix} Move the store into a folder only you can access.`
            : `${prefix} The Forge folder could not be made private.`,
          { cause: error },
        );
      let owner: string | undefined;
      let descriptor: string | undefined;
      try {
        owner = native.owner(path);
        descriptor = native.read(path);
      } catch {
        owner = undefined;
        descriptor = undefined;
      }
      if (owner !== native.sid)
        throw new Error(
          `${prefix} Owner: ${owner ?? "unknown"}. Ask that owner or an administrator to review its permissions.`,
          { cause: error },
        );
      if (descriptor === undefined || !canRepairFile(descriptor, ownTrustees))
        throw new Error(
          `${prefix} Its access restrictions require review by the owner or an administrator before repair.`,
          { cause: error },
        );
      const literal = powershellLiteral(path);
      const replacement = `D:P(A;;FA;;;${native.sid})`;
      const repair = `$acl = New-Object System.Security.AccessControl.FileSecurity; $acl.SetSecurityDescriptorSddlForm(${powershellLiteral(replacement)}, [System.Security.AccessControl.AccessControlSections]::Access); $item = Get-Item -LiteralPath ${literal}; if ($PSVersionTable.PSEdition -eq ${powershellLiteral("Core")}) { [System.IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) } else { $item.SetAccessControl($acl) }`;
      throw new Error(
        `${prefix} Stop Forge connections, then repair and retry. Repair in PowerShell:\n${repair}`,
        { cause: error },
      );
    }
  }
  return {
    directory: (path, created) => verify(path, true, created),
    file: (path) => verify(path, false),
  };
}
