// The user's own package manager: found from their lockfile or packageManager field, never chosen
// by Forge, and used only to run a script their package.json declares. The lockfile and manifest
// reading is the project block's Node detector, so what this adapter reports and what
// `project.detect` shows can never disagree.
import type { Unavailable } from "../../generated/types.ts";
import {
  createFolderFiles,
  type ProjectFiles,
} from "../../blocks/project/files.ts";
import {
  resolveNodePackageManager,
  scriptArguments,
} from "../../blocks/project/detect-node.ts";
import type {
  DetectedPackageManager,
  PackageManagerPort,
} from "../../ports/package-manager.ts";
import type { ProcessPort, ProcessResult } from "../../ports/process.ts";

export interface PackageManagerAdapterOptions {
  readonly process: ProcessPort;
  /** The environment the manager runs in. */
  readonly env: Readonly<Record<string, string>>;
  readonly maxOutputBytes: number;
  /** How project files are read; defaults to the folder on disk. */
  readonly files?: (projectRoot: string) => ProjectFiles;
}

function unavailable(reason: string, remedy: string): Unavailable {
  return { kind: "unavailable", reason, remedy };
}

function declaredScripts(files: ProjectFiles): {
  readonly scripts: Readonly<Record<string, string>>;
  readonly problem?: Unavailable;
} {
  const text = files.read("package.json");
  if (text === undefined) {
    return {
      scripts: {},
      problem: unavailable(
        "there is no package.json in this folder",
        "Run from a project folder that has a package.json.",
      ),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      scripts: {},
      problem: unavailable(
        "package.json is not valid JSON",
        "Fix the syntax error in package.json.",
      ),
    };
  }
  const scripts: Record<string, string> = {};
  const block =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { scripts?: unknown }).scripts
      : undefined;
  if (typeof block === "object" && block !== null) {
    for (const [name, body] of Object.entries(block)) {
      if (typeof body === "string") scripts[name] = body;
    }
  }
  return { scripts };
}

export function createPackageManagerPort(
  options: PackageManagerAdapterOptions,
): PackageManagerPort {
  const filesOf = options.files ?? createFolderFiles;

  function detect(projectRoot: string): DetectedPackageManager | Unavailable {
    const resolution = resolveNodePackageManager(filesOf(projectRoot));
    if (resolution === undefined) {
      return unavailable(
        "there is no package.json in this folder",
        "Run from a project folder that has a package.json.",
      );
    }
    if (resolution.kind === "conflict") {
      const named = Object.entries(resolution.managers)
        .map(([name, file]) => `${name} (${file})`)
        .join(", ");
      return unavailable(
        `lockfiles for several package managers are present: ${named}`,
        "Declare packageManager in package.json, or delete the lockfile you do not use.",
      );
    }
    if (resolution.kind === "none") {
      return unavailable(
        resolution.reason,
        "Run your package manager's install to create a lockfile, or set packageManager in package.json.",
      );
    }
    return {
      kind: "detected",
      name: resolution.name,
      ...(resolution.version === undefined
        ? {}
        : { version: resolution.version }),
      evidence: resolution.evidence,
    };
  }

  return {
    detect(projectRoot: string): Promise<DetectedPackageManager | Unavailable> {
      return Promise.resolve(detect(projectRoot));
    },

    scripts(projectRoot: string): Promise<Readonly<Record<string, string>>> {
      return Promise.resolve(declaredScripts(filesOf(projectRoot)).scripts);
    },

    async runScript(
      projectRoot: string,
      script: string,
      args: readonly string[],
      timeoutMs: number,
    ): Promise<ProcessResult | Unavailable> {
      const manager = detect(projectRoot);
      if (manager.kind === "unavailable") return manager;
      const { scripts, problem } = declaredScripts(filesOf(projectRoot));
      if (problem !== undefined) return problem;
      if (!Object.hasOwn(scripts, script) || script.startsWith("-")) {
        const names = Object.keys(scripts);
        return unavailable(
          `package.json declares no script named "${script}"`,
          names.length === 0
            ? "package.json declares no scripts; add one under scripts."
            : `Declared scripts: ${names.join(", ")}.`,
        );
      }
      const executable = options.process.resolve(manager.name, options.env);
      if (executable.kind === "unavailable") return executable;
      return options.process.run(
        executable,
        scriptArguments(manager.name, script, args),
        {
          cwd: projectRoot,
          env: options.env,
          timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
        },
      );
    },
  };
}
