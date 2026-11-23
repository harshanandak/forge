import { readInput } from "./shared.js";

async function runSessionStart(): Promise<void> {
  await readInput();
}

await runSessionStart().catch(() => undefined);
