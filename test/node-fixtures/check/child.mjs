import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const mode = process.argv[2];
if (mode === "unknown") console.log("project-owned check finished");
if (mode === "zero") console.log("Tests:       0 total");
if (mode === "malformed") console.log('{"numTotalTests":');
if (mode === "fail") process.exitCode = 4;
if (mode === "environment") {
  if (
    process.env.CHECK_PARENT_ONLY !== undefined ||
    process.env.CHECK_SELECTED !== "child"
  )
    process.exitCode = 9;
  else console.log("isolated environment");
}
if (mode === "timeout") {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "idle"],
    { stdio: "ignore", windowsHide: true },
  );
  console.log(`descendant:${child.pid}`);
  console.log("output before timeout");
  setInterval(() => {}, 1000);
}
if (mode === "idle") setInterval(() => {}, 1000);
