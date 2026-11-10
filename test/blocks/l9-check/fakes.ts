import { StreamCapture } from "../../../src/adapters/process/capture.ts";
import type {
  ProcessResult,
  SpawnOptions,
} from "../../../src/ports/process.ts";
import type { CheckServices } from "../../../src/blocks/check/types.ts";

export function trackedChanges(
  services: CheckServices,
  snapshots: readonly (readonly string[])[],
): void {
  const run = services.process.run.bind(services.process);
  let calls = 0;
  services.process.run = (executable, args, options) => {
    if (executable.path !== "git") return run(executable, args, options);
    const paths = snapshots[Math.min(calls++, snapshots.length - 1)] ?? [];
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: paths.length ? paths.join("\0") + "\0" : "",
      stderr: "",
      timedOut: false,
      truncated: false,
      durationMs: 1,
    });
  };
}

export function captured(
  result: ProcessResult,
  options: SpawnOptions,
): ProcessResult {
  if (!options.capture || result.outputEvidence) return result;
  options.observer?.push("stdout", Buffer.from(result.stdout));
  options.observer?.push("stderr", Buffer.from(result.stderr));
  const stdout = new StreamCapture(options.maxOutputBytes, options.capture);
  const stderr = new StreamCapture(options.maxOutputBytes, options.capture);
  stdout.push(Buffer.from(result.stdout));
  stderr.push(Buffer.from(result.stderr));
  return {
    ...result,
    stdout: stdout.text(),
    stderr: stderr.text(),
    truncated: result.truncated || stdout.truncated || stderr.truncated,
    outputEvidence: {
      stdout: stdout.evidence(true),
      stderr: stderr.evidence(true),
    },
  };
}
