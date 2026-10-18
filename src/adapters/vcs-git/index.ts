import { resolve as resolvePath } from "node:path";
import type { Unavailable } from "../../generated/types.ts";
import type { ProcessPort, ProcessResult } from "../../ports/process.ts";
import type { VcsPort, WorkingTreeStatus } from "../../ports/vcs.ts";

export type GitErrorCode = "GIT_UNAVAILABLE" | "GIT_FAILED";

/** A git command that a read operation could not answer (the Unavailable-returning ones report it as a value instead). */
export class GitCommandError extends Error {
  readonly code: GitErrorCode;
  readonly exitCode: number | null;

  constructor(code: GitErrorCode, message: string, exitCode: number | null) {
    super(message);
    this.name = "GitCommandError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface VcsAdapterOptions {
  readonly process: ProcessPort;
  /** The environment git runs in; location variables (GIT_DIR and friends) are removed from it. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/**
 * Variables that point git somewhere other than the directory we ask about. They leak in when Forge
 * itself runs inside a git hook or a test of git, and they silently redirect every command.
 */
const LOCATION_VARIABLES = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);

function gitEnvironment(
  base: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (!LOCATION_VARIABLES.has(name.toUpperCase())) env[name] = value;
  }
  // Reads never write: status must not refresh the index. Messages are parsed, so keep them in English.
  env["GIT_OPTIONAL_LOCKS"] = "0";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["LC_ALL"] = "C";
  return env;
}

function unavailable(reason: string, remedy: string): Unavailable {
  return { kind: "unavailable", reason, remedy };
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

function describeFailure(result: ProcessResult): Unavailable {
  if (result.timedOut) {
    return unavailable(
      "git did not finish in time",
      "Retry, or check that the repository is on a responsive disk.",
    );
  }
  const message = firstLine(result.stderr);
  if (/not a git repository/i.test(message)) {
    return unavailable(
      "this folder is not inside a git repository",
      "Run from inside a repository, or create one with git init.",
    );
  }
  if (/dubious ownership/i.test(message)) {
    return unavailable(
      `git refuses this repository: ${message}`,
      "Mark the folder safe with git config --global --add safe.directory <path>.",
    );
  }
  return unavailable(
    message === "" ? `git exited with ${result.exitCode}` : message,
    "Run the same git command by hand to see the full error.",
  );
}

const REF_UNSAFE = /[\0\r\n]/;
const REMOTE_NAME =
  /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

export function createVcsPort(options: VcsAdapterOptions): VcsPort {
  const env = gitEnvironment(options.env);

  type Outcome =
    | { readonly ok: true; readonly result: ProcessResult }
    | { readonly ok: false; readonly unavailable: Unavailable };

  async function git(cwd: string, args: readonly string[]): Promise<Outcome> {
    const found = options.process.resolve("git", env);
    if (found.kind === "unavailable") return { ok: false, unavailable: found };
    try {
      const result = await options.process.run(found, args, {
        cwd,
        env,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof Error && error.name === "ProcessSpawnError") {
        return {
          ok: false,
          unavailable: unavailable(
            error.message,
            "Check that the folder exists and git can be started.",
          ),
        };
      }
      throw error;
    }
  }

  /** Run git where only a value can come back; any failure throws. */
  async function mustGit(
    cwd: string,
    args: readonly string[],
    acceptExit: readonly number[] = [0],
  ): Promise<ProcessResult> {
    const outcome = await git(cwd, args);
    if (!outcome.ok) {
      throw new GitCommandError(
        "GIT_UNAVAILABLE",
        `${outcome.unavailable.reason}. ${outcome.unavailable.remedy}`,
        null,
      );
    }
    const { result } = outcome;
    if (
      result.timedOut ||
      result.exitCode === null ||
      !acceptExit.includes(result.exitCode)
    ) {
      throw new GitCommandError(
        "GIT_FAILED",
        `git ${args[0] ?? ""} failed: ${describeFailure(result).reason}`,
        result.exitCode,
      );
    }
    return result;
  }

  return {
    async root(dir: string): Promise<string | Unavailable> {
      const outcome = await git(dir, ["rev-parse", "--show-toplevel"]);
      if (!outcome.ok) return outcome.unavailable;
      const { result } = outcome;
      if (result.exitCode !== 0) return describeFailure(result);
      return resolvePath(result.stdout.trim());
    },

    async revision(root: string, ref: string): Promise<string | Unavailable> {
      if (ref === "" || REF_UNSAFE.test(ref)) {
        return unavailable(
          "the ref is empty or holds a control character",
          "Pass a branch, tag or revision name.",
        );
      }
      const outcome = await git(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${ref}^{commit}`,
      ]);
      if (!outcome.ok) return outcome.unavailable;
      const { result } = outcome;
      if (result.exitCode === 0) return result.stdout.trim();
      if (result.exitCode === 1 && firstLine(result.stderr) === "") {
        return unavailable(
          `"${ref}" does not name a commit in this repository`,
          "Fetch the ref first, or pass a name that exists.",
        );
      }
      return describeFailure(result);
    },

    async currentBranch(root: string): Promise<string | undefined> {
      // exit 1 with --quiet means HEAD is detached; an unborn branch still has a name.
      const result = await mustGit(
        root,
        ["symbolic-ref", "--quiet", "HEAD"],
        [0, 1],
      );
      if (result.exitCode === 1) return undefined;
      return result.stdout.trim().replace(/^refs\/heads\//, "");
    },

    async defaultBranch(
      root: string,
      remote: string,
    ): Promise<string | Unavailable> {
      if (!REMOTE_NAME.test(remote)) {
        return unavailable(
          `"${remote}" is not a usable remote name`,
          "Pass the remote's name, for example origin.",
        );
      }
      const prefix = `refs/remotes/${remote}/`;
      const outcome = await git(root, [
        "symbolic-ref",
        "--quiet",
        `${prefix}HEAD`,
      ]);
      if (!outcome.ok) return outcome.unavailable;
      const { result } = outcome;
      if (result.exitCode === 0) {
        const target = result.stdout.trim();
        return target.startsWith(prefix) ? target.slice(prefix.length) : target;
      }
      if (result.exitCode === 1) {
        return unavailable(
          `the default branch of "${remote}" is not recorded locally`,
          `Fetch it, then run git remote set-head ${remote} --auto.`,
        );
      }
      return describeFailure(result);
    },

    async status(root: string): Promise<WorkingTreeStatus> {
      const result = await mustGit(root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      const entries = result.stdout.split("\0").filter((entry) => entry !== "");
      const changed = new Set<string>();
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index] as string;
        const code = entry.slice(0, 2);
        changed.add(entry.slice(3));
        // A rename or copy lists its source as the next entry; that path changed too.
        if (/[RC]/.test(code)) {
          index += 1;
          const source = entries[index];
          if (source !== undefined) changed.add(source);
        }
      }
      const sorted = [...changed].sort();
      return { clean: sorted.length === 0, changed: sorted };
    },
  };
}
