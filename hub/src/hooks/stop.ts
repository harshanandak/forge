import { readInput } from "./shared.js";

async function runStop(): Promise<void> {
  await readInput();
}

await runStop().catch(() => undefined);
