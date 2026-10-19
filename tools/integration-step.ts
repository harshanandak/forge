import { fileURLToPath } from "node:url";
import { runStep } from "./step-runner.ts";
import { readRunnerPolicy } from "./runner-policy.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const bun = process.argv[2];
if (!bun || process.argv.length !== 3)
  throw new Error("usage: node tools/integration-step.ts <bun-executable>");
const policy = readRunnerPolicy();
const jobs = [
  {
    label: "pack smoke",
    executable: process.execPath,
    args: ["tools/pack-smoke/run.ts", "--state-test", bun],
  },
  {
    label: "integration-rest",
    executable: bun,
    args: ["tools/test-suite.ts", "integration-rest", "--timeout", "30000"],
  },
];
try {
  await runStep(jobs, root, process.env, policy);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
