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
  const snapshot = services.snapshot.bind(services);
  let calls = 0;
  Object.assign(services, {
    snapshot: async () => ({
      ...(await snapshot()),
      dirtyPaths: snapshots[Math.min(calls++, snapshots.length - 1)] ?? [],
    }),
  });
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
