export function asyncCounterfactuals(platform: NodeJS.Platform) {
  return [
    ...(platform === "win32"
      ? [
          {
            file: "adapters/process/windows-job.js",
            from: "if (api.terminateJobObject(job, 1) === 0)",
            to: "if (true)",
            mode: "job-termination",
            evidence: "typed interruption",
          },
        ]
      : []),
    {
      file: "core/runtime/index.js",
      from: "await scope.prepare(handle?.value);",
      to: "void 0;",
      mode: "strict-refusal",
      evidence: "strict containment must refuse before activation",
    },
    {
      // Windows has no tree left to walk once the root exits, so it proves cancellation instead.
      file: "adapters/process/process-tree.js",
      from: "(await endProcessTree(pid, platform, supervision))",
      to: "(child.kill('SIGKILL'), true)",
      mode: platform === "win32" ? "cancel" : "default-cleanup",
      evidence: "invocation must stop its entire process tree",
    },
    {
      file: "adapters/node-runtime/isolation.js",
      from: "Promise.resolve(handler(args))",
      to: "Promise.reject(Error('sync-only ABI'))",
      mode: "async",
      evidence: "async child process must complete",
    },
    {
      file: "core/runtime/services.js",
      from: "this.check();",
      to: "void 0;",
      mode: "scope",
      evidence: "settled services must refuse writes",
    },
    {
      file: "core/runtime/index.js",
      from: "this.#trust.check(block.digest, declaration.effects);",
      to: "void 0;",
      mode: "grants",
      evidence: "async effect needs human grant",
    },
    {
      file: "core/runtime/services.js",
      from: ".run(executable, args, {",
      to: ".run(executable, args, {",
      mode: "timeout",
      evidence: "invocation must stop its entire process tree",
    },
    {
      file: "core/runtime/index.js",
      from: 'code: "INVOCATION_CANCELLED"',
      to: 'code: "INVOCATION_TIMEOUT"',
      mode: "cancel",
      evidence: "typed interruption",
    },
    {
      file: "core/runtime/services.js",
      from: "this.check();",
      to: "void 0;",
      mode: "leased",
      evidence: "settled leased client must not write",
    },
  ];
}
