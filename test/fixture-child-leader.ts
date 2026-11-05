// This Windows-only leader waits until its Job Object is installed before forking.
// Keep it alive until the command exits, even if that command leaves descendants.
const [command, encodedArgs] = process.argv.slice(2);
if (!command || !encodedArgs)
  throw new Error("Fixture command and arguments required");
process.stdin.once("data", () => {
  void import("node:child_process").then(({ spawn }) => {
    const child = spawn(command, JSON.parse(encodedArgs) as string[], {
      stdio: ["ignore", 1, 2],
      windowsHide: true,
    });
    child.once("error", (error) => {
      process.send?.({
        error: error.message,
        code: (error as NodeJS.ErrnoException).code,
      });
      process.exitCode = 1;
      process.stdin.destroy();
      process.disconnect?.();
    });
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
      process.stdin.destroy();
      process.disconnect?.();
    });
  });
});
