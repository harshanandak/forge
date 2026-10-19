// A scripted ProcessPort for unit tests of everything that spawns: no real process, no PATH walk.
import type { Unavailable } from "../../../src/generated/types.ts";
import type {
  ProcessPort,
  ProcessResult,
  ResolvedExecutable,
  SpawnOptions,
} from "../../../src/ports/process.ts";

export interface RecordedRun {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

export type Script = (run: RecordedRun) => Partial<ProcessResult> | undefined;

export interface FakeProcess extends ProcessPort {
  readonly runs: RecordedRun[];
}

export function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: 1,
    ...overrides,
  };
}

/** `known` lists the executables that resolve; the script answers each run, defaulting to exit 0. */
export function fakeProcess(
  known: readonly string[],
  script: Script = () => undefined,
): FakeProcess {
  const runs: RecordedRun[] = [];
  return {
    capability: "forge.process/v1",
    runs,
    resolve(executable: string): ResolvedExecutable | Unavailable {
      return known.includes(executable)
        ? { kind: "resolved", path: `/fake/bin/${executable}` }
        : {
            kind: "unavailable",
            reason: `"${executable}" was not found on PATH`,
            remedy: `Install ${executable}.`,
          };
    },
    run(
      executable: ResolvedExecutable,
      args: readonly string[],
      options: SpawnOptions,
    ): Promise<ProcessResult> {
      const recorded = { executable: executable.path, args, options };
      runs.push(recorded);
      return Promise.resolve(result(script(recorded)));
    },
  };
}
