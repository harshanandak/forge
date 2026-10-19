const run = async ({ input, services, signal }) => {
  const env = services.environment.select(input.names || []);
  const executable = services.process.resolve(input.executable, env);
  if (executable.kind !== "resolved") throw Error("fixture executable missing");
  return services.process.run(executable, input.args, {
    cwd: services.process.cwd,
    env,
    timeoutMs: input.timeoutMs || 8000,
    maxOutputBytes: 4096,
    signal,
  });
};
module.exports = {
  "provider.run": run,
  "provider.timeout": run,
  "provider.deniedprocess": run,
  "provider.env": ({ input, services }) =>
    services.environment.select(input.names),
  "provider.deniedenv": ({ services }) => services.environment.select(["PATH"]),
  "provider.read": ({ input, services }) =>
    services.files.read(input.path, input.maxBytes, input.area) ?? null,
  "provider.deniedfiles": ({ services }) =>
    services.files.read("input.txt", 1024),
  "provider.deniedwrite": ({ services }) =>
    services.files.write("unauthorized.txt", "unexpected"),
  "provider.write": ({ input, services }) => {
    services.files.write(input.path, input.text, input.options);
    return true;
  },
  "provider.remove": ({ input, services }) => {
    services.files.remove(input.path, input.options);
    return true;
  },
  "provider.snapshot": ({ input, services }) => services.files.snapshot(input),
  "provider.crypto": ({ input, services }) => ({
    digest: services.crypto.sha256(input.text),
    uuid: services.crypto.randomUUID(),
    root: services.files.root,
    roots: services.files.roots,
  }),
};
