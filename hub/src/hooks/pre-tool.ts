import { readInput } from "./shared.js";

async function runPreTool(): Promise<number> {
  await readInput();
  return 0;
}

process.exitCode = await runPreTool().catch(() => {
  process.stderr.write(
    "Forge hub could not confirm this session (INVALID_INPUT). Read tools inside the working directory still work.\n",
  );
  return 2;
});
