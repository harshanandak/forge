import type { DetectionObservation } from "../../generated/types.ts";
import { detectCi } from "./detect-ci.ts";
import { detectDecisions } from "./detect-decisions.ts";
import { detectGo } from "./detect-go.ts";
import { detectHooks } from "./detect-hooks.ts";
import { detectNode } from "./detect-node.ts";
import { detectPython } from "./detect-python.ts";
import { detectRust } from "./detect-rust.ts";
import { detectTasks } from "./detect-tasks.ts";
import { detectTrackers } from "./detect-trackers.ts";
import type { ProjectFiles } from "./files.ts";

export interface Detector {
  readonly id: string;
  run(files: ProjectFiles): DetectionObservation[];
}

/** Every detector, in the order their observations are reported. Each describes what exists and nothing more. */
export const DETECTORS: readonly Detector[] = [
  { id: "node", run: detectNode },
  { id: "python", run: detectPython },
  { id: "rust", run: detectRust },
  { id: "go", run: detectGo },
  { id: "tasks", run: detectTasks },
  { id: "hooks", run: detectHooks },
  { id: "ci", run: detectCi },
  { id: "trackers", run: detectTrackers },
  { id: "decisions", run: detectDecisions },
];

export interface DetectorFailure {
  readonly detector: string;
  readonly message: string;
}

export interface DetectionReport {
  readonly observations: readonly DetectionObservation[];
  /** A detector that threw; the others still ran and their observations are in the report. */
  readonly failures: readonly DetectorFailure[];
}

/** Run every detector over one project. Reads only; nothing is written and nothing is executed. */
export function detectProject(
  files: ProjectFiles,
  detectors: readonly Detector[] = DETECTORS,
): DetectionReport {
  const observations: DetectionObservation[] = [];
  const failures: DetectorFailure[] = [];
  for (const detector of detectors) {
    try {
      observations.push(...detector.run(files));
    } catch (error) {
      failures.push({
        detector: detector.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { observations, failures };
}
