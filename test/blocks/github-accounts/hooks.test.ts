import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

setDefaultTimeout(1000);

function fixture() {
  const source = readFileSync(
    new URL("../../../src/blocks/github-accounts/entry.cts", import.meta.url),
    "utf8",
  );
  const module = {
    exports: {} as { verifyHookArtifacts: (...args: unknown[]) => void },
  };
  runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      source + "\nmodule.exports={verifyHookArtifacts};",
    ),
    {
      module,
      fail(code: string, message: string) {
        throw Object.assign(new Error(message), { code });
      },
    },
  );
  const path = ".forge-github-accounts/hooks/pre-push";
  const recorded = "#!/bin/sh\n# recorded previous configuration\n";
  const routes = [
    { worktree: "/clone", hook: `/clone/.git/${path}` },
    { worktree: "/linked", hook: `/clone/.git/${path}` },
  ];
  let text: string | undefined = recorded;
  let executable = true;
  let reads = 0;
  const s = {
    environment: { platform: "linux" },
    files: {
      inspect: () => ({ executable }),
      read: () => {
        reads++;
        return text;
      },
    },
  };
  return {
    verify: () =>
      module.exports.verifyHookArtifacts(
        s,
        { maxFileBytes: 10000 },
        { artifacts: { [path]: recorded } },
        routes,
      ),
    setText(value: string | undefined) {
      text = value;
    },
    setExecutable(value: boolean) {
      executable = value;
    },
    get reads() {
      return reads;
    },
  };
}

test("guard verification reads the recorded bytes at every effective worktree route", () => {
  const f = fixture();
  f.verify();
  expect(f.reads).toBe(2);
});

test("missing, changed and POSIX nonexecutable guards refuse without replacement", () => {
  for (const alteration of ["missing", "foreign", "mode"]) {
    const f = fixture();
    if (alteration === "missing") f.setText(undefined);
    if (alteration === "foreign") f.setText("#!/bin/sh\n# user changed this\n");
    if (alteration === "mode") f.setExecutable(false);
    let error: unknown;
    try {
      f.verify();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "ACCOUNT_HOOK_ARTIFACT_INVALID" });
  }
});
