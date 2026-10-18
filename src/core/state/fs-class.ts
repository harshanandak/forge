export interface FilesystemSignals {
  readonly path: string;
  readonly platform: string;
  readonly cloudRoots?: readonly string[];
  readonly driveType?: "local" | "network" | "unknown";
  readonly mountType?: string;
  readonly wsl?: boolean;
}
export interface FilesystemClass {
  readonly kind: "local" | "cloud" | "network" | "cross" | "unknown";
  readonly risk: "safe" | "warn" | "refuse";
}

export function trimTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) end--;
  return value.slice(0, end);
}
export function pathWithin(
  path: string,
  root: string,
  insensitive: boolean,
): boolean {
  const normalize = (value: string): string => {
    const normalized = trimTrailingSeparators(value.replace(/[\\/]+/g, "/"));
    return insensitive ? normalized.toLowerCase() : normalized;
  };
  const a = normalize(path),
    b = normalize(root);
  return b.length > 0 && (a === b || a.startsWith(`${b}/`));
}
export function classifyFilesystem(
  signals: FilesystemSignals,
): FilesystemClass {
  const { path, platform } = signals;
  if (path === ":memory:") return { kind: "local", risk: "safe" };
  if (
    /^(?:\\\\|\/\/)/.test(path) ||
    signals.driveType === "network" ||
    ["cifs", "smb", "smb3", "nfs", "nfs4", "fuse.sshfs"].includes(
      signals.mountType ?? "",
    )
  )
    return { kind: "network", risk: "refuse" };
  const segments = path.toLowerCase().split(/[\\/]+/);
  if (
    (signals.cloudRoots ?? []).some((root) =>
      pathWithin(path, root, platform === "win32"),
    ) ||
    segments.some((part) =>
      /^(?:onedrive(?:[ -].*)?|dropbox|google ?drive|drivefs)$/.test(part),
    ) ||
    /\/Library\/(?:Mobile Documents|CloudStorage)\//.test(path) ||
    ["fuse.rclone", "fuse.dropbox", "fuse.google-drive-ocamlfuse"].includes(
      signals.mountType ?? "",
    )
  )
    return { kind: "cloud", risk: "refuse" };
  if (signals.wsl && /^\/mnt\/[a-z](?:\/|$)/i.test(path))
    return { kind: "cross", risk: "warn" };
  if (signals.driveType === "local" || signals.mountType !== undefined)
    return { kind: "local", risk: "safe" };
  return { kind: "unknown", risk: "warn" };
}
const warned = new Set<string>();
/** The host supplies its stderr sink; classifications never pollute structured stdout. */
export function assertFilesystem(
  signals: FilesystemSignals,
  stderr: (message: string) => void,
): void {
  const classification = classifyFilesystem(signals);
  if (classification.risk === "refuse")
    throw new Error(
      `Store requires a local unsynced filesystem (${classification.kind})`,
    );
  if (classification.risk === "warn" && !warned.has(classification.kind)) {
    warned.add(classification.kind);
    stderr(
      `Store filesystem warning: ${classification.kind}; prefer a local unsynced disk\n`,
    );
  }
}
