// The version-control port. git is the one external tool the package may require; its adapter is
// the only place it is invoked.
import type { Unavailable } from "../generated/types.ts";

export interface WorkingTreeStatus {
  readonly clean: boolean;
  /** Paths with uncommitted changes, relative to the repository root, forward slashes. */
  readonly changed: readonly string[];
}

export interface VcsPort {
  /** The repository root containing `dir`, or Unavailable when there is none. */
  root(dir: string): Promise<string | Unavailable>;
  /** The exact revision a ref points at. */
  revision(root: string, ref: string): Promise<string | Unavailable>;
  /** The checked-out branch, or undefined when detached. */
  currentBranch(root: string): Promise<string | undefined>;
  /** The remote's default branch, read from the fetched remote. */
  defaultBranch(root: string, remote: string): Promise<string | Unavailable>;
  status(root: string): Promise<WorkingTreeStatus>;
}
