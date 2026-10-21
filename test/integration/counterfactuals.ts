export type FirstSliceMutation = {
  file: string;
  from: string;
  to: string;
  mode: string;
  fixture?: string;
  evidence: string;
};

export const firstSliceMutations: readonly FirstSliceMutation[] = [
  {
    file: "src/core/runtime/deadline.js",
    from: "const timeoutMs = Math.min(...limits);",
    to: "const timeoutMs = 1000;",
    mode: "deadline",
    fixture: "review-two",
    evidence: "declared durable budget must complete",
  },
  {
    file: "src/assembly/state.js",
    from: "ensurePrivateDirectory(dirname(this.#path), this.#directories);",
    to: "void 0;",
    mode: "directories",
    fixture: "review-two",
    evidence: "each parent must be synced in order",
  },
  {
    file: "src/adapters/store-sqlite/file-ops.js",
    from: "syncParentDirectory(directory, fs);",
    to: "void 0;",
    mode: "directories",
    fixture: "review-two",
    evidence: "each parent must be synced in order",
  },
  {
    file: "src/adapters/store-sqlite/file-ops.js",
    from: "for (const directory of directories.reverse()) {",
    to: "for (const directory of directories.reverse()) { try { if (fs.statSync(directory).isDirectory()) continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }",
    mode: "directory-retry",
    fixture: "review-two",
    evidence: "retry must re-sync the failed parent before opening storage",
  },
  {
    file: "src/assembly/command.js",
    from: "process.stdout.write(`${version}\\n`);",
    to: "await (await createLocalAssembly()).prepareTrust(); process.stdout.write(`${version}\\n`);",
    mode: "bootstrap",
    fixture: "review-two",
    evidence: "version must not open local state",
  },
  {
    file: "src/assembly/index.js",
    from: 'if (request.op === "config.show")',
    to: "if (false)",
    mode: "bootstrap",
    fixture: "review-two",
    evidence: "broken trust store must fail loudly",
  },
  {
    file: "src/assembly/index.js",
    from: "readyBindings(active, name);",
    to: "void 0;",
    mode: "implicit-bindings",
    fixture: "review-two",
    evidence: "unsupported implicit bindings must not be advertised",
  },
  {
    file: "src/assembly/index.js",
    from: "const reason = error instanceof ForgeFailure",
    to: "throw error; const reason = error instanceof ForgeFailure",
    mode: "bad-docs",
    fixture: "review-two",
    evidence: "config show must retain readable invalid configuration",
  },
  {
    file: "src/assembly/index.js",
    from: "const namespace = current.blocks.get(instance).manifest.id;",
    to: "if (context.variant !== 'project') continue; const namespace = current.blocks.get(instance).manifest.id;",
    mode: "bindings",
    fixture: "review-two",
    evidence: "required service must be available",
  },
  {
    file: "src/assembly/state.js",
    from: "if (--entry.refs !== 0)",
    to: "if (false)",
    mode: "lifetime",
    fixture: "review-two",
    evidence: "first invocation cannot close",
  },
  {
    file: "src/assembly/state.js",
    from: "const result = this.#queue.then(work);",
    to: "const result = work();",
    mode: "lifetime",
    fixture: "review-two",
    evidence: "concurrent first opens must be serialized",
  },

  {
    file: "src/assembly/index.js",
    from: "const reason = error instanceof ForgeFailure",
    to: "throw error; const reason = error instanceof ForgeFailure",
    mode: "missing-sources",
    fixture: "review",
    evidence: "config show:",
  },
  {
    file: "src/assembly/capture.js",
    from: "const candidate = join(directory, source.package);",
    to: 'const candidate = resolve(require.resolve(`${source.package}/package.json`), "..");',
    mode: "package-roots",
    fixture: "review",
    evidence: "block check hidden-block",
  },

  {
    file: "src/assembly/index.js",
    from: "detectProject(createFolderFiles(root)).observations",
    to: "[]",
    mode: "detection",
    evidence: "derived npm command",
  },
  {
    file: "src/core/runtime/index.js",
    from: "this.#trust.check(block.digest, effects);",
    to: "void 0;",
    mode: "admission",
    evidence: "unadmitted agent call",
  },
  {
    file: "src/assembly/command.js",
    from: "catalog: assembly.catalog",
    to: "catalog: { list: () => [], invoke: assembly.catalog.invoke }",
    mode: "all",
    evidence: "Unknown operation: config.show",
  },
  {
    file: "src/assembly/state-client.js",
    from: "structuredClone(value)",
    to: "value",
    mode: "normalization",
    fixture: "review-two",
    evidence: "State values must be plain JSON",
  },
  ...["all", "race"].map((mode) => ({
    file: "src/assembly/state-client.js",
    from: "expectRevision: put.expectRevision",
    to: "expectRevision: owner.get(namespace, key)?.revision ?? 0",
    mode,
    evidence: mode === "race" ? "one writer wins" : "semver mark 1.6.0 0",
  })),
];
