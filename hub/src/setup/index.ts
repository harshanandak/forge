export function runSetupCommand(argv: readonly string[]): number {
  const command = argv[0];
  if (command === "init" || command === "doctor") {
    process.stderr.write(`not_built: ${command}\n`);
  }
  return 1;
}
