import { StreamCapture } from "../../../src/adapters/process/capture.ts";
import type {
  ProcessResult,
  SpawnOptions,
} from "../../../src/ports/process.ts";

export function captured(
  result: ProcessResult,
  options: SpawnOptions,
): ProcessResult {
  if (!options.capture || result.outputEvidence) return result;
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
