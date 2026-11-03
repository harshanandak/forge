export type CiJob = {
  name: string;
  conclusion: string | null;
  runner_name: string;
  steps: readonly unknown[];
};
export type CiRun = {
  conclusion: string | null;
  run_attempt: number;
  jobs: readonly CiJob[];
};
export function decideRerun(_run: CiRun): {
  rerun: boolean;
  reason: string;
} {
  return { rerun: false, reason: "Runner-allocation rerun not implemented" };
}
