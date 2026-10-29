import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

try {
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../../dist/bin/forge.js", import.meta.url)),
      "memory",
      "rules",
      "--input",
      JSON.stringify({ notes: true }),
    ],
    {
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  if (child.error) throw child.error;
  let response;
  try {
    response = JSON.parse(child.stdout);
  } catch {
    throw { code: child.status === 0 ? "INVALID_RESPONSE" : "PROCESS_FAILED" };
  }
  if (response?.ok === false) throw response.error;
  if (child.status !== 0) throw { code: "PROCESS_FAILED" };
  if (response?.ok !== true || typeof response.result?.text?.text !== "string")
    throw { code: "INVALID_RESPONSE" };
  console.log(response.result.text.text);
  const receipt = response.result.receipt;
  const omitted = receipt?.omitted?.length ?? 0;
  const warnings = receipt?.warnings?.length ?? 0;
  if (omitted || warnings)
    console.log(
      `Forge memory receipt: ${omitted} omitted, ${warnings} warnings; forge memory rules --notes --json`,
    );
} catch (error) {
  const code =
    typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)
      ? error.code
      : "INVALID_RESPONSE";
  console.log(`Forge memory unavailable: ${code}`);
}
