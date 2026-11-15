import { realpathSync } from "node:fs";
import { relative, join } from "node:path";
import { cloudBinding } from "./cloud-binding.ts";
import { LocalState } from "./state.ts";
import {
  boundLaneKey,
  readBoundLane,
} from "../blocks/work/bound-lane-state.ts";
import {
  projectManifestRoot,
  reopenGitScope,
  type GitScope,
} from "./providers.ts";

/** Only a matching private attachment may recover ancestry before the first Git discovery. */
export async function deviceGitScope(
  root: string,
  deviceRoot: string,
  home?: string,
  explicit?: GitScope,
): Promise<GitScope | null | undefined> {
  const device = new LocalState(join(deviceRoot, "records.sqlite"));
  try {
    const binding = cloudBinding(root, home);
    if (binding.kind !== "bound") return reopenGitScope(root, explicit);
    const owner = await device.open(false);
    const target = realpathSync.native(projectManifestRoot(root));
    const prefix = boundLaneKey(binding);
    const matches =
      owner?.list("forge/work", prefix).filter((row) => {
        const lane = (row.value as { lane?: { worktree?: unknown } })?.lane;
        return (
          typeof lane?.worktree === "string" &&
          relative(lane.worktree, target) === ""
        );
      }) ?? [];
    if (!matches.length) return reopenGitScope(root, explicit);
    const scopes = matches.map((row) => {
      const lane = readBoundLane(row.value, row.key.slice(prefix.length)).lane;
      return reopenGitScope(root, lane.gitScope ?? null);
    });
    return scopes.every(
      (scope) => JSON.stringify(scope) === JSON.stringify(scopes[0]),
    )
      ? scopes[0]
      : null;
  } catch {
    // Diagnostics and release remain available; Git consumers refuse this explicit missing scope.
    return null;
  } finally {
    await device.close();
  }
}
