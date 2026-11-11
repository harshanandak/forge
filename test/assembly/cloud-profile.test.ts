import { expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  credentialStore,
  openCloudFiles,
  parseDeviceCredential,
  readBinding,
  resolveTarget,
  writeBinding,
  BINDING_PATH,
  CREDENTIAL_FILE,
} from "../../src/assembly/cloud-profile.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  bindingFor,
  credentialJson,
  DAY,
  entry,
  ORIGIN,
  OTHER_ORIGIN,
  OTHER_PROJECT_ID,
  PROJECT,
  PROJECT_ID,
  sandbox,
  SECRET,
  tokenFor,
} from "./cloud-fixture.ts";

setDefaultTimeout(30_000);
const NOW = Date.UTC(2026, 10, 11);

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ForgeFailure) return error.error.code;
    throw error;
  }
  return "NO_FAILURE";
}
async function asyncCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ForgeFailure) return error.error.code;
    throw error;
  }
  return "NO_FAILURE";
}
const fileText = (path: string): string => readFileSync(path, "utf8");
const noWait = () => Promise.resolve();

const invalidCredentials: [string, string | Record<string, unknown>][] = [
  ["text that is not JSON", "not json"],
  ["an array", "[]"],
  ["another format", { format: "forge/device-credential/2" }],
  ["an id that is not 16 hex digits", { id: "xyz" }],
  ["a token of the wrong shape", { token: `bearer ${SECRET}` }],
  ["a token that names another id", { token: tokenFor("ffffffffffffffff") }],
  ["a different device", { device: "someone-else" }],
  ["an expiry that is a number", { expiresAt: NOW + DAY }],
  ["an expiry that is only a date", { expiresAt: "2026-12-11" }],
  ["an expiry already past", { expiresAt: new Date(NOW - 1).toISOString() }],
  ["an expiry exactly now", { expiresAt: new Date(NOW).toISOString() }],
  [
    "an expiry beyond 91 days",
    { expiresAt: new Date(NOW + 92 * DAY).toISOString() },
  ],
  ["an unknown field", { extra: "x" }],
  ["no token", { token: undefined }],
];

test("a Worker credential is parsed to its four fields and expiry stays the ISO string", () => {
  const parsed = parseDeviceCredential(credentialJson(NOW), "dev-1", NOW);
  expect(parsed).toEqual({
    id: "0123456789abcdef",
    token: tokenFor(),
    device: "dev-1",
    expiresAt: new Date(NOW + 30 * DAY).toISOString(),
  });
}, 10_000);

for (const [name, change] of invalidCredentials)
  test(`a credential with ${name} is refused and the token is not quoted`, () => {
    const text =
      typeof change === "string" ? change : credentialJson(NOW, change);
    try {
      parseDeviceCredential(text, "dev-1", NOW);
    } catch (error) {
      expect(error).toBeInstanceOf(ForgeFailure);
      const failed = error as ForgeFailure;
      expect(failed.error.code).toBe("UNAVAILABLE");
      expect(JSON.stringify(failed.error)).not.toContain(SECRET);
      expect(JSON.stringify(failed.error)).not.toContain("fct_");
      return;
    }
    throw new Error("expected a refusal");
  }, 10_000);

test("a saved credential is found by its exact origin, project UUID and project name only", async () => {
  const s = sandbox();
  try {
    const store = credentialStore(openCloudFiles(s.home), { wait: noWait });
    const saved = entry(NOW);
    await store.save(saved);
    const key = { origin: ORIGIN, identity: PROJECT_ID, project: PROJECT };
    expect(store.lookup(key, NOW)).toEqual({
      id: saved.id,
      token: saved.token,
      device: saved.device,
      expiresAt: saved.expiresAt,
    });
    for (const other of [
      { ...key, origin: OTHER_ORIGIN },
      { ...key, identity: OTHER_PROJECT_ID },
      { ...key, project: "other-project" },
      { ...key, origin: `${ORIGIN}:8443` },
    ])
      expect(store.lookup(other, NOW)).toBeUndefined();
    expect(store.lookup(key, NOW + 31 * DAY)).toBeUndefined();
  } finally {
    s.close();
  }
}, 20_000);

test("another project binds and saves its own entry without touching the first", async () => {
  const s = sandbox();
  try {
    const store = credentialStore(openCloudFiles(s.home), { wait: noWait });
    const first = entry(NOW);
    const second = entry(NOW, {
      identity: OTHER_PROJECT_ID,
      origin: OTHER_ORIGIN,
      id: "bbbbbbbbbbbbbbbb",
      token: tokenFor("bbbbbbbbbbbbbbbb", "P".repeat(43)),
    });
    await store.save(first);
    await store.save(second);
    expect(
      store.lookup(
        { origin: ORIGIN, identity: PROJECT_ID, project: PROJECT },
        NOW,
      )?.id,
    ).toBe(first.id);
    expect(
      store.lookup(
        { origin: OTHER_ORIGIN, identity: OTHER_PROJECT_ID, project: PROJECT },
        NOW,
      )?.id,
    ).toBe(second.id);
    expect(store.associations(PROJECT_ID)).toEqual([
      { origin: ORIGIN, identity: PROJECT_ID, project: PROJECT },
    ]);
    expect(store.associations("33333333-3333-4333-8333-333333333333")).toEqual(
      [],
    );
  } finally {
    s.close();
  }
}, 20_000);

test("a second login for the same key replaces only that entry, merged into the latest file", async () => {
  const s = sandbox();
  try {
    const store = credentialStore(openCloudFiles(s.home), { wait: noWait });
    await store.save(entry(NOW));
    // Another process adds an entry after this one started: nothing is cached.
    await credentialStore(openCloudFiles(s.home), { wait: noWait }).save(
      entry(NOW, {
        identity: OTHER_PROJECT_ID,
        id: "cccccccccccccccc",
        token: tokenFor("cccccccccccccccc", "C".repeat(43)),
      }),
    );
    const renewed = entry(NOW, {
      id: "dddddddddddddddd",
      token: tokenFor("dddddddddddddddd", "D".repeat(43)),
    });
    await store.save(renewed);
    const key = { origin: ORIGIN, identity: PROJECT_ID, project: PROJECT };
    expect(store.lookup(key, NOW)?.id).toBe("dddddddddddddddd");
    expect(store.lookup({ ...key, identity: OTHER_PROJECT_ID }, NOW)?.id).toBe(
      "cccccccccccccccc",
    );
    expect(fileText(s.credentials)).not.toContain("aaaaaaaaaaaaaaaa");
  } finally {
    s.close();
  }
}, 20_000);

test("the file lock is bounded: a held lock fails the save and changes nothing", async () => {
  const s = sandbox();
  try {
    const files = openCloudFiles(s.home);
    const store = credentialStore(files, { wait: noWait, attempts: 3 });
    await store.save(entry(NOW));
    const before = fileText(s.credentials);
    const held = files.lock();
    let pauses = 0;
    const blocked = credentialStore(files, {
      attempts: 3,
      wait: () => {
        pauses += 1;
        return Promise.resolve();
      },
    });
    const code = await asyncCodeOf(() =>
      blocked.save(entry(NOW, { identity: OTHER_PROJECT_ID })),
    );
    held.release();
    expect(code).toBe("INPUT_CONFLICT");
    expect(pauses).toBe(2);
    expect(fileText(s.credentials)).toBe(before);
    await blocked.save(entry(NOW, { identity: OTHER_PROJECT_ID }));
  } finally {
    s.close();
  }
}, 20_000);

test("a damaged credential file is an integrity failure for reads and saves and is never rewritten", async () => {
  const s = sandbox();
  try {
    const files = openCloudFiles(s.home);
    for (const damaged of [
      "not json",
      "[]",
      JSON.stringify({ schema: 2, entries: {} }),
      JSON.stringify({ schema: 1, entries: { x: { token: "t" } } }),
    ]) {
      files.write(CREDENTIAL_FILE, damaged);
      const store = credentialStore(files, { wait: noWait });
      expect(codeOf(() => store.associations(PROJECT_ID))).toBe(
        "ACCOUNT_INTEGRITY",
      );
      expect(
        codeOf(() =>
          store.lookup(
            { origin: ORIGIN, identity: PROJECT_ID, project: PROJECT },
            NOW,
          ),
        ),
      ).toBe("ACCOUNT_INTEGRITY");
      expect(await asyncCodeOf(() => store.save(entry(NOW)))).toBe(
        "ACCOUNT_INTEGRITY",
      );
      expect(fileText(s.credentials)).toBe(damaged);
    }
  } finally {
    s.close();
  }
}, 20_000);

test("a credential file over the read limit is refused, not truncated", async () => {
  const s = sandbox();
  try {
    const files = openCloudFiles(s.home);
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < 4_000; i++)
      entries[`${ORIGIN}|${PROJECT_ID}|p${i}`] = entry(NOW, {
        project: `p${i}`,
      });
    const text = JSON.stringify({ schema: 1, entries });
    expect(text.length).toBeGreaterThan(1_048_576);
    // The helper will not write what it could not read back, so grow the file directly.
    files.write(CREDENTIAL_FILE, "{}");
    writeFileSync(s.credentials, text);
    const store = credentialStore(files, { wait: noWait });
    expect(await asyncCodeOf(() => store.save(entry(NOW)))).toBe(
      "ACCOUNT_INTEGRITY",
    );
    expect(fileText(s.credentials)).toBe(text);
  } finally {
    s.close();
  }
}, 30_000);

function failing(fails: (path: string) => boolean) {
  return {
    directory() {},
    file(path: string) {
      if (fails(path)) throw new Error(`Private ACL refused: ${path}`);
    },
  };
}

test("a failure before the replace keeps the previous file byte for byte", async () => {
  const s = sandbox();
  try {
    let staged = false;
    const files = openCloudFiles(
      s.home,
      failing((path) => staged && basename(path) !== CREDENTIAL_FILE),
    );
    const store = credentialStore(files, { wait: noWait });
    await store.save(entry(NOW));
    const before = fileText(s.credentials);
    staged = true;
    expect(
      await asyncCodeOf(() =>
        store.save(
          entry(NOW, {
            id: "eeeeeeeeeeeeeeee",
            token: tokenFor("eeeeeeeeeeeeeeee"),
          }),
        ),
      ),
    ).toBe("ACCOUNT_INTEGRITY");
    staged = false;
    expect(fileText(s.credentials)).toBe(before);
    expect(
      store.lookup(
        { origin: ORIGIN, identity: PROJECT_ID, project: PROJECT },
        NOW,
      )?.id,
    ).toBe("aaaaaaaaaaaaaaaa");
  } finally {
    s.close();
  }
}, 20_000);

test("a failure after the replace restores the previous valid entry", async () => {
  const s = sandbox();
  try {
    const newer = entry(NOW, {
      id: "ffffffffffffffff",
      token: tokenFor("ffffffffffffffff", "NEWMARK".padEnd(43, "N")),
    });
    // The published file reads back wrong: it carries the new token.
    const files = openCloudFiles(
      s.home,
      failing(
        (path) =>
          basename(path) === CREDENTIAL_FILE &&
          fileText(path).includes("NEWMARK"),
      ),
    );
    const store = credentialStore(files, { wait: noWait });
    await store.save(entry(NOW));
    const before = fileText(s.credentials);
    expect(await asyncCodeOf(() => store.save(newer))).toBe(
      "ACCOUNT_INTEGRITY",
    );
    expect(fileText(s.credentials)).toBe(before);
    expect(
      store.lookup(
        { origin: ORIGIN, identity: PROJECT_ID, project: PROJECT },
        NOW,
      )?.id,
    ).toBe("aaaaaaaaaaaaaaaa");
  } finally {
    s.close();
  }
}, 20_000);

test("a first save whose readback fails reports an integrity failure and finds nothing to restore", async () => {
  const s = sandbox();
  try {
    const files = openCloudFiles(
      s.home,
      failing(
        (path) =>
          basename(path) === CREDENTIAL_FILE &&
          fileText(path).includes("NEWMARK"),
      ),
    );
    const store = credentialStore(files, { wait: noWait });
    const failed = await asyncCodeOf(() =>
      store.save(
        entry(NOW, {
          token: tokenFor("aaaaaaaaaaaaaaaa", "NEWMARK".padEnd(43, "N")),
        }),
      ),
    );
    expect(failed).toBe("ACCOUNT_INTEGRITY");
  } finally {
    s.close();
  }
}, 20_000);

test("an absent binding reads as undefined and a valid one reads back", () => {
  const s = sandbox();
  try {
    expect(readBinding(s.root)).toBeUndefined();
    writeFileSync(s.binding, `${JSON.stringify(bindingFor())}\n`);
    expect(readBinding(s.root)).toEqual(bindingFor());
  } finally {
    s.close();
  }
}, 20_000);

const badBindings: [string, string][] = [
  ["text that is not JSON", "nope"],
  ["an array", "[]"],
  ["another schema", JSON.stringify({ ...bindingFor(), schema: 2 })],
  ["an unknown field", JSON.stringify({ ...bindingFor(), token: "t" })],
  [
    "an identity that is not a UUID",
    JSON.stringify({ ...bindingFor(), identity: "x" }),
  ],
  [
    "an origin with a path",
    JSON.stringify({ ...bindingFor(), origin: `${ORIGIN}/x` }),
  ],
  [
    "an http origin",
    JSON.stringify({ ...bindingFor(), origin: "http://forge.example.test" }),
  ],
  [
    "a project that fails the route grammar",
    JSON.stringify({ ...bindingFor(), project: "../x" }),
  ],
  [
    "more than 4 KiB",
    JSON.stringify({ ...bindingFor(), project: "p" }) + " ".repeat(5_000),
  ],
];
for (const [name, text] of badBindings)
  test(`a binding with ${name} fails closed`, () => {
    const s = sandbox();
    try {
      writeFileSync(s.binding, text);
      expect(codeOf(() => readBinding(s.root))).toBe("INPUT_INVALID");
    } finally {
      s.close();
    }
  }, 20_000);

test("a binding that is a symlink is refused", () => {
  if (process.platform === "win32") return;
  const s = sandbox();
  try {
    writeFileSync(join(s.dir, "real.json"), JSON.stringify(bindingFor()));
    symlinkSync(join(s.dir, "real.json"), s.binding);
    expect(codeOf(() => readBinding(s.root))).not.toBe("NO_FAILURE");
  } finally {
    s.close();
  }
}, 20_000);

test("writing a binding creates it once and never changes an existing one", () => {
  const s = sandbox();
  try {
    expect(existsSync(s.binding)).toBe(false);
    expect(writeBinding(s.root, bindingFor())).toBe("created");
    expect(JSON.parse(fileText(s.binding))).toEqual(bindingFor());
    const before = fileText(s.binding);
    expect(writeBinding(s.root, bindingFor())).toBe("unchanged");
    expect(
      codeOf(() => writeBinding(s.root, bindingFor({ origin: OTHER_ORIGIN }))),
    ).toBe("INPUT_CONFLICT");
    expect(
      codeOf(() => writeBinding(s.root, bindingFor({ project: "other" }))),
    ).toBe("INPUT_CONFLICT");
    expect(fileText(s.binding)).toBe(before);
    expect(BINDING_PATH).toBe(".forge/cloud.json");
  } finally {
    s.close();
  }
}, 20_000);

const key = (origin = ORIGIN, project = PROJECT) => ({
  origin,
  identity: PROJECT_ID,
  project,
});

test("the first login needs an explicit origin and project", () => {
  expect(
    resolveTarget(
      { origin: ORIGIN, project: PROJECT },
      PROJECT_ID,
      undefined,
      [],
    ),
  ).toEqual({
    origin: ORIGIN,
    project: PROJECT,
  });
  expect(codeOf(() => resolveTarget({}, PROJECT_ID, undefined, []))).toBe(
    "INPUT_INVALID",
  );
  expect(
    codeOf(() => resolveTarget({ origin: ORIGIN }, PROJECT_ID, undefined, [])),
  ).toBe("INPUT_INVALID");
}, 10_000);

test("a later login uses the existing binding and may repeat it, but cannot change it", () => {
  const binding = bindingFor();
  expect(resolveTarget({}, PROJECT_ID, binding, [key()])).toEqual({
    origin: ORIGIN,
    project: PROJECT,
  });
  expect(
    resolveTarget(
      { origin: ORIGIN, project: PROJECT },
      PROJECT_ID,
      binding,
      [],
    ),
  ).toEqual({
    origin: ORIGIN,
    project: PROJECT,
  });
  for (const input of [{ origin: OTHER_ORIGIN }, { project: "other" }])
    expect(codeOf(() => resolveTarget(input, PROJECT_ID, binding, []))).toBe(
      "INPUT_CONFLICT",
    );
}, 10_000);

test("a binding edited away from the saved association is a conflict before any request", () => {
  expect(
    codeOf(() =>
      resolveTarget({}, PROJECT_ID, bindingFor({ origin: OTHER_ORIGIN }), [
        key(ORIGIN),
      ]),
    ),
  ).toBe("INPUT_CONFLICT");
  expect(
    codeOf(() =>
      resolveTarget(
        { origin: OTHER_ORIGIN, project: PROJECT },
        PROJECT_ID,
        bindingFor({ origin: OTHER_ORIGIN }),
        [key(ORIGIN)],
      ),
    ),
  ).toBe("INPUT_CONFLICT");
  expect(
    codeOf(() =>
      resolveTarget(
        {},
        PROJECT_ID,
        bindingFor({ identity: OTHER_PROJECT_ID }),
        [],
      ),
    ),
  ).toBe("INPUT_CONFLICT");
}, 10_000);

test("a missing binding with a saved association repairs only toward that association", () => {
  expect(resolveTarget({}, PROJECT_ID, undefined, [key()])).toEqual({
    origin: ORIGIN,
    project: PROJECT,
  });
  expect(
    resolveTarget({ origin: ORIGIN, project: PROJECT }, PROJECT_ID, undefined, [
      key(),
    ]),
  ).toEqual({
    origin: ORIGIN,
    project: PROJECT,
  });
  expect(
    codeOf(() =>
      resolveTarget(
        { origin: OTHER_ORIGIN, project: PROJECT },
        PROJECT_ID,
        undefined,
        [key()],
      ),
    ),
  ).toBe("INPUT_CONFLICT");
  expect(
    codeOf(() =>
      resolveTarget({}, PROJECT_ID, undefined, [
        key(ORIGIN),
        key(OTHER_ORIGIN),
      ]),
    ),
  ).toBe("INPUT_CONFLICT");
}, 10_000);

test("the credential directory is created only when a credential is saved", async () => {
  const s = sandbox();
  try {
    const store = credentialStore(openCloudFiles(s.home), { wait: noWait });
    expect(store.associations(PROJECT_ID)).toEqual([]);
    expect(existsSync(join(s.home, ".forge", "cloud"))).toBe(false);
    mkdirSync(join(s.home, ".forge"), { recursive: true });
    await store.save(entry(NOW));
    expect(existsSync(s.credentials)).toBe(true);
  } finally {
    s.close();
  }
}, 20_000);
