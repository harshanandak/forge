import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  createProcessPort,
  ProcessSpawnError,
} from "../adapters/process/index.ts";
import { createRunnerOutput } from "../adapters/runner-output/index.ts";
import {
  mainCheckoutPath,
  originRepositoryName,
} from "../adapters/vcs-git/index.ts";
import type { DetectionObservation } from "../generated/types.ts";
import type { RunnerOutputPort } from "../ports/runner-output.ts";
import type { SupervisionOptions } from "../adapters/process/supervision.ts";
import {
  createCloneFilesLease,
  digestCloneFiles,
  type CloneFilesService,
} from "../adapters/fs/clone-files.ts";
import type {
  ProcessPort,
  ProcessResult,
  SpawnOptions,
} from "../ports/process.ts";
import type { OwnedHandle } from "../ports/lifetime.ts";
import type { ServiceScope } from "../core/runtime/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { interfaceSatisfies } from "../contract/version.ts";

export type { CloneFilesService } from "../adapters/fs/clone-files.ts";
export type {
  RunnerOutputPort,
  OutputReport,
  ReportFormat,
} from "../ports/runner-output.ts";
export interface FileSnapshotInput {
  readonly paths: readonly string[];
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}
export interface FilesService extends CloneFilesService {
  snapshot(
    input: FileSnapshotInput,
  ): Promise<{ head: string; filesDigest: string }>;
}
export interface EnvironmentService {
  readonly platform: NodeJS.Platform;
  select(names: readonly string[]): Readonly<Record<string, string>>;
}
export interface CryptoService {
  sha256(text: string): string;
  randomUUID(): string;
}
export interface ProcessService extends ProcessPort {
  readonly cwd: string;
}
export interface ProviderOptions {
  readonly supervision?: SupervisionOptions;
  readonly maxFileBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
}
export interface AssemblyProviders {
  process(scope: ServiceScope): ProcessService;
  environment(scope: ServiceScope): EnvironmentService;
  crypto(scope: ServiceScope): CryptoService;
  runnerOutput(scope: ServiceScope): RunnerOutputPort;
  openFiles(scope: ServiceScope): Promise<OwnedHandle<FilesService>>;
}
interface InternalProviders extends AssemblyProviders {
  files(
    scope: ServiceScope,
    executor: ProcessPort,
  ): Promise<OwnedHandle<FilesService>>;
}

/** Host cleanup ceilings, not workflow policy. No supervisor exists until a launch. */
const CLEANUP: SupervisionOptions = {
  cleanupTimeoutMs: 5000,
  pollIntervalMs: 25,
  drainTimeoutMs: 250,
  maxConcurrent: 1,
};
/** Stop the tree, await the supervisor, then drain its pipes: sequential bounds. */
export function processCleanupBudgetMs(options?: SupervisionOptions): number {
  const timing = options ?? CLEANUP;
  return 2 * timing.cleanupTimeoutMs + timing.drainTimeoutMs;
}
// Windows load exceeded the old 4.75 s Git window. Each of two HEAD lookups
// needs a 10 s startup window plus the process service's cleanup bound.
const SNAPSHOT_HEAD_MS = 10000;
export const SNAPSHOT_TIMEOUT_MS: number =
  2 * (SNAPSHOT_HEAD_MS + processCleanupBudgetMs());
/** An operation wrapping one snapshot also needs time to return its result. */
export const SNAPSHOT_OPERATION_TIMEOUT_MS: number = SNAPSHOT_TIMEOUT_MS + 1000;
export const ASSEMBLY_PROVIDES: readonly string[] = [
  "forge.state@1.0.0",
  "forge.process@1.0.0",
  "forge.files@1.0.0",
  "forge.environment@1.0.0",
  "forge.crypto@1.0.0",
  "forge.runner-output@1.0.0",
  "forge.project-state@1.0.0",
];
export function assemblyProvides(required: string): boolean {
  return ASSEMBLY_PROVIDES.some((provided) =>
    interfaceSatisfies(provided, required),
  );
}
function refuse(code: string, message: string): never {
  throw new ForgeFailure({ code, message, retry: "never" });
}
function active(scope: ServiceScope): void {
  if (scope.signal.aborted)
    refuse("SERVICE_EXPIRED", "Invocation was cancelled");
  if (Date.now() >= scope.deadline)
    refuse("INVOCATION_TIMEOUT", "Invocation deadline exceeded");
}

/** The runtime also wraps this capability, drains pending calls and revokes cached methods. */
export function createProcessService(
  port: ProcessPort,
  scope: ServiceScope,
  cwd: string,
): ProcessService {
  return {
    capability: "forge.process/v1",
    cwd,
    ...(port.containment
      ? {
          containment: () => {
            active(scope);
            return port.containment!();
          },
        }
      : {}),
    resolve(executable, environment) {
      active(scope);
      return port.resolve(executable, environment);
    },
    async run(executable, args, options: SpawnOptions) {
      active(scope);
      if (!scope.effects.includes("external:process"))
        refuse(
          "EFFECT_UNDECLARED",
          "Launching a process requires external:process on this operation",
        );
      const signal = options.signal
        ? AbortSignal.any([scope.signal, options.signal])
        : scope.signal;
      return port.run(executable, args, {
        ...options,
        signal,
        timeoutMs: Math.min(
          options.timeoutMs,
          Math.max(1, scope.deadline - Date.now()),
        ),
        containment: scope.processContainment,
      });
    },
  };
}

function hostEnv(options: ProviderOptions): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(options.env ??
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )),
  });
}

// Discovery calls share the host's single supervisor; each lookup is launched once in order.
let gitDiscovery = Promise.resolve();
function gitOptions(options: ProviderOptions) {
  const port = createProcessPort({
    supervision: options.supervision ?? CLEANUP,
  });
  return {
    process: {
      ...port,
      async run(...args: Parameters<ProcessPort["run"]>) {
        const pending = gitDiscovery.then(() => port.run(...args));
        gitDiscovery = pending.then(
          () => undefined,
          () => undefined,
        );
        try {
          return await pending;
        } catch (error) {
          // A busy supervisor says nothing about the repository's identity.
          if (
            error instanceof ProcessSpawnError &&
            error.code === "PROCESS_LIMIT_EXCEEDED"
          )
            throw new ForgeFailure({
              code: error.code,
              message: "Process capacity is unavailable for Git discovery",
              retry: "never",
            });
          throw error;
        }
      },
    },
    env: hostEnv(options),
    timeoutMs: 10000,
    maxOutputBytes: 16384,
  };
}

/** Where project state lives: in a linked git worktree, the same folder in the main working tree. */
export function projectStateRoot(
  root: string,
  options: ProviderOptions = {},
): Promise<string> {
  return mainCheckoutPath(root, gitOptions(options));
}

/** A name as an issue id prefix: lowercase letters, digits and single hyphens; undefined when none remain. */
export function idPrefix(name: string): string | undefined {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 32)
      .replace(/^-+|-+$/g, "") || undefined
  );
}

/**
 * The work block's derived `idPrefix`: the origin repository's name, else the main checkout's
 * folder name, so every worktree of one repository mints the same ids. It fills the `work`
 * instance like the detected check commands fill `check`; a set value always wins.
 */
export async function idPrefixObservation(
  root: string,
  stateRoot: string,
  options: ProviderOptions = {},
): Promise<readonly DetectionObservation[]> {
  const repository = await originRepositoryName(root, gitOptions(options));
  const value = idPrefix(repository ?? basename(stateRoot));
  return value === undefined
    ? []
    : [
        {
          key: "/blocks/work/config/idPrefix",
          value,
          origin: {
            detector: "project.detect",
            note:
              repository === undefined
                ? "the project folder's name"
                : "the origin remote's repository name",
          },
        },
      ];
}

export function createAssemblyProviders(
  root: string,
  options: ProviderOptions = {},
  suppliedProcess?: ProcessPort,
): AssemblyProviders {
  const env = hostEnv(options);
  const port =
    suppliedProcess ??
    createProcessPort({
      supervision: options.supervision ?? CLEANUP,
    });
  const providers: InternalProviders = {
    runnerOutput(scope: ServiceScope): RunnerOutputPort {
      const output = createRunnerOutput();
      return {
        parse(stdout, stderr, format) {
          active(scope);
          return output.parse(stdout, stderr, format);
        },
        recognize(format) {
          active(scope);
          return output.recognize(format);
        },
      };
    },
    process(scope: ServiceScope): ProcessService {
      return createProcessService(port, scope, root);
    },
    environment(scope: ServiceScope): EnvironmentService {
      return {
        get platform(): NodeJS.Platform {
          active(scope);
          return process.platform;
        },
        select(names: readonly string[]): Readonly<Record<string, string>> {
          const requested: readonly string[] = names;
          active(scope);
          if (!scope.effects.includes("environment:read"))
            refuse(
              "EFFECT_UNDECLARED",
              "Selecting environment variables requires environment:read",
            );
          if (
            !Array.isArray(names) ||
            names.length > 1024 ||
            names.some(
              (name) =>
                typeof name !== "string" ||
                !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
                name.length > 256,
            )
          )
            refuse(
              "INPUT_INVALID",
              "Select up to 1024 explicit environment variable names",
            );
          const selected: Record<string, string> = {};
          for (const name of requested) {
            const key =
              process.platform === "win32"
                ? Object.keys(env).find(
                    (key) => key.toUpperCase() === name.toUpperCase(),
                  )
                : name;
            if (key !== undefined && Object.hasOwn(env, key))
              Object.defineProperty(selected, key, {
                value: env[key]!,
                enumerable: true,
                writable: true,
                configurable: true,
              });
          }
          return selected;
        },
      };
    },
    crypto(scope: ServiceScope): CryptoService {
      return {
        sha256(text: string): string {
          active(scope);
          if (typeof text !== "string" || Buffer.byteLength(text) > 1048576)
            refuse(
              "LIMIT_EXCEEDED",
              "Hash input exceeds the 1 MiB safety ceiling",
            );
          return createHash("sha256").update(text, "utf8").digest("hex");
        },
        randomUUID(): string {
          active(scope);
          return randomUUID();
        },
      };
    },
    async openFiles(scope: ServiceScope): Promise<OwnedHandle<FilesService>> {
      if (scope.processContainment === "strict") {
        const capability = await port.containment?.();
        if (!capability?.available)
          refuse(
            "CONTAINMENT_UNAVAILABLE",
            "Strict containment is unavailable for clone-file Git reads",
          );
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([scope.signal, controller.signal]);
      const pending = new Set<Promise<ProcessResult>>();
      const cleanupErrors: unknown[] = [];
      let fileLease: OwnedHandle<FilesService> | undefined;
      const executor: ProcessPort = {
        ...port,
        run(executable, args, options) {
          const result = port.run(executable, args, {
            ...options,
            signal,
            containment: scope.processContainment,
          });
          pending.add(result);
          void result.then(
            () => pending.delete(result),
            (error: unknown) => {
              pending.delete(result);
              if (
                error !== null &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "TREE_KILL_FAILED"
              )
                cleanupErrors.push(error);
            },
          );
          return result;
        },
      };
      const close = async (): Promise<void> => {
        controller.abort();
        await Promise.allSettled([...pending]);
        await fileLease?.close();
        if (cleanupErrors.length)
          throw new AggregateError(
            cleanupErrors,
            "Clone-file process cleanup failed",
          );
      };
      try {
        fileLease = await providers.files(
          {
            ...scope,
            signal,
            get deadline() {
              return scope.deadline;
            },
          },
          executor,
        );
        return { ownership: "owned", value: fileLease.value, close };
      } catch (error) {
        await close();
        throw error;
      }
    },
    async files(
      scope: ServiceScope,
      executor: ProcessPort,
    ): Promise<OwnedHandle<FilesService>> {
      active(scope);
      // Git, not caller input or a .git text file, resolves linked-worktree roots.
      const discoveryEnv = Object.fromEntries(
        Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)),
      );
      discoveryEnv.GIT_OPTIONAL_LOCKS = "0";
      discoveryEnv.GIT_TERMINAL_PROMPT = "0";
      const git = executor.resolve("git", discoveryEnv);
      if (git.kind !== "resolved")
        refuse("UNAVAILABLE", "Clone files require Git on PATH");
      const result = await executor.run(
        git,
        [
          "-C",
          root,
          "rev-parse",
          "--path-format=absolute",
          "--absolute-git-dir",
          "--git-common-dir",
        ],
        {
          cwd: root,
          env: discoveryEnv,
          signal: scope.signal,
          timeoutMs: Math.max(1, scope.deadline - Date.now()),
          maxOutputBytes: 16384,
        },
      );
      if (result.exitCode !== 0 || result.timedOut || result.truncated)
        refuse(
          "UNAVAILABLE",
          "Clone files require an accessible local Git repository",
        );
      const paths = result.stdout.trim().split(/\r?\n/);
      if (paths.length !== 2 || !paths[0] || !paths[1])
        refuse("UNAVAILABLE", "Git did not return clone directories");
      active(scope);
      const fileOptions = {
        projectRoot: realpathSync.native(root),
        gitDirectory: realpathSync.native(paths[0]),
        commonDirectory: realpathSync.native(paths[1]),
        read: scope.effects.includes("files:read"),
        write: scope.effects.includes("files:write"),
        signal: scope.signal,
        get deadline() {
          return scope.deadline;
        },
        ...(options.maxFileBytes === undefined
          ? {}
          : { maxBytes: options.maxFileBytes }),
      };
      const lease = createCloneFilesLease(fileOptions);
      const value: FilesService = {
        ...lease.service,
        async snapshot(input: FileSnapshotInput) {
          active(scope);
          if (!scope.effects.includes("files:read"))
            refuse("EFFECT_UNDECLARED", "File snapshots require files:read");
          const timeoutMs = input.timeoutMs;
          if (
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            !Number.isSafeInteger(input.maxOutputBytes) ||
            input.maxOutputBytes < 1 ||
            input.maxOutputBytes > 1048576
          )
            refuse(
              "INPUT_INVALID",
              "Declare a positive snapshot timeout and output budget up to 1 MiB",
            );
          const deadline = Math.min(
            scope.deadline,
            Date.now() + Math.min(timeoutMs, SNAPSHOT_TIMEOUT_MS),
          );
          const cleanupMs = processCleanupBudgetMs(options.supervision);
          const snapshotActive = (): void => {
            active(scope);
            if (Date.now() >= deadline)
              refuse("INVOCATION_TIMEOUT", "Snapshot deadline exceeded");
          };
          const head = async (): Promise<string> => {
            snapshotActive();
            const remaining = deadline - Date.now() - cleanupMs;
            if (remaining < 1)
              refuse(
                "INVOCATION_TIMEOUT",
                "Snapshot has no time left for Git and cleanup",
              );
            const result = await executor.run(
              git,
              ["-C", root, "rev-parse", "--verify", "HEAD"],
              {
                cwd: root,
                env: discoveryEnv,
                signal: scope.signal,
                timeoutMs: remaining,
                maxOutputBytes: input.maxOutputBytes,
              },
            );
            if (result.timedOut)
              refuse("INVOCATION_TIMEOUT", "Snapshot head lookup timed out");
            snapshotActive();
            if (
              result.exitCode !== 0 ||
              result.truncated ||
              !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.stdout.trim())
            )
              refuse(
                "INPUT_CONFLICT",
                'Snapshot requires an exact Git HEAD. If this repository has no first commit, create it with: git add -A && git commit -m "initial commit". Otherwise repair HEAD and retry.',
              );
            return result.stdout.trim();
          };
          const before = await head();
          const filesDigest = digestCloneFiles(
            { ...fileOptions, deadline },
            input.paths,
            input.maxBytes,
          );
          const after = await head();
          snapshotActive();
          if (before !== after)
            refuse("INPUT_CONFLICT", "Git HEAD changed during snapshot");
          return { head: after, filesDigest };
        },
      };
      return {
        ownership: "owned",
        value,
        close: () => {
          lease.close();
          return Promise.resolve();
        },
      };
    },
  };
  return providers;
}
