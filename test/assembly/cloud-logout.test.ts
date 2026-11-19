import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createCloudLogin,
  type CloudLoginDeps,
} from "../../src/assembly/cloud-login.ts";
import {
  credentialStore,
  openCloudFiles,
} from "../../src/assembly/cloud-profile.ts";
import {
  bindingFor,
  clock,
  entry,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  sandbox,
  SECRET,
  tokenFor,
  type Sandbox,
} from "./cloud-fixture.ts";

setDefaultTimeout(30_000);

type Run = (input: unknown) => Promise<unknown>;

function logoutFor(sb: Sandbox, more: Partial<CloudLoginDeps> = {}): Run {
  const service = createCloudLogin({
    root: sb.root,
    home: sb.home,
    deviceRoot: sb.deviceRoot,
    env: { FORGE_DEVICE_ID: "dev-1" },
    signal: new AbortController().signal,
    fetch: () => Promise.reject(new Error("logout must not use the network")),
    ...more,
  });
  const holder: object = service;
  return (input) => (holder as { logout: Run }).logout(input);
}

const now = clock().now();
const store = (sb: Sandbox) => credentialStore(openCloudFiles(sb.home));
const otherTokenId = "bbbbbbbbbbbbbbbb";
const other = () =>
  entry(now, {
    identity: OTHER_PROJECT_ID,
    project: "other",
    id: otherTokenId,
    token: tokenFor(otherTokenId),
  });
const read = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, "utf8") : null;
const bind = (sb: Sandbox) =>
  writeFileSync(sb.binding, `${JSON.stringify(bindingFor(), null, 2)}\n`);

test("logout removes this project's credential and the binding, keeps other projects, and prints no secret", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(other());
    const otherOnly = readFileSync(sb.credentials);
    await store(sb).save(entry(now));
    bind(sb);
    const result = await logoutFor(sb)({});
    expect(result).toEqual({
      status: "logged-out",
      origin: "https://forge.example.test",
      project: "proj",
      tokenId: "aaaaaaaaaaaaaaaa",
      tokenRevoked: false,
    });
    expect(JSON.stringify(result)).not.toContain("fct_");
    expect(read(sb.binding)).toBeNull();
    expect(store(sb).associations(PROJECT_ID)).toEqual([]);
    expect(readFileSync(sb.credentials).equals(otherOnly)).toBe(true);
  } finally {
    sb.close();
  }
});

test("a second logout, and a logout with no binding, change nothing", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(other());
    await store(sb).save(entry(now));
    const before = read(sb.credentials);
    const expected = { status: "not-bound", tokenRevoked: false };
    expect(await logoutFor(sb)({})).toEqual(expected);
    expect(read(sb.credentials)).toBe(before);
    bind(sb);
    await logoutFor(sb)({});
    const after = read(sb.credentials);
    expect(await logoutFor(sb)({})).toEqual(expected);
    expect(read(sb.credentials)).toBe(after);
  } finally {
    sb.close();
  }
});

test("a binding whose credential is already gone is still removed, and no token id is reported", async () => {
  const sb = sandbox();
  try {
    bind(sb);
    expect(await logoutFor(sb)({})).toEqual({
      status: "logged-out",
      origin: "https://forge.example.test",
      project: "proj",
      tokenRevoked: false,
    });
    expect(read(sb.binding)).toBeNull();
  } finally {
    sb.close();
  }
});

test("logout refuses to remove a binding that changed after it was read", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(entry(now));
    bind(sb);
    const replacement = `${JSON.stringify(bindingFor({ project: "other" }))}\n`;
    const before = read(sb.credentials);
    const result = logoutFor(sb)({});
    writeFileSync(sb.binding, replacement);
    await expect(result).rejects.toMatchObject({
      error: {
        code: "INPUT_CONFLICT",
        retry: "reconcile_first",
      },
    });
    expect(read(sb.binding)).toBe(replacement);
    expect(read(sb.credentials)).toBe(before);
  } finally {
    sb.close();
  }
});

test("a credential file that fails its integrity check is left as it is and the binding stays", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(entry(now));
    bind(sb);
    writeFileSync(sb.credentials, "{}");
    await expect(logoutFor(sb)({})).rejects.toMatchObject({
      error: { code: "ACCOUNT_INTEGRITY" },
    });
    expect(read(sb.credentials)).toBe("{}");
    expect(read(sb.binding)).not.toBeNull();
  } finally {
    sb.close();
  }
});

test("a binding for another project identity removes nothing", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(entry(now));
    writeFileSync(
      sb.binding,
      `${JSON.stringify(bindingFor({ identity: OTHER_PROJECT_ID }), null, 2)}\n`,
    );
    const before = read(sb.credentials);
    await expect(logoutFor(sb)({})).rejects.toMatchObject({
      error: { code: "INPUT_CONFLICT" },
    });
    expect(read(sb.credentials)).toBe(before);
    expect(read(sb.binding)).not.toBeNull();
  } finally {
    sb.close();
  }
});

test("input with a value is refused as invalid and never echoed", async () => {
  const sb = sandbox();
  try {
    bind(sb);
    const error = await logoutFor(sb)({ token: SECRET }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ error: { code: "INPUT_INVALID" } });
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(read(sb.binding)).not.toBeNull();
  } finally {
    sb.close();
  }
});

for (const when of [
  "before invocation",
  "after lock acquisition",
  "before credential removal",
  "before binding removal",
] as const)
  test(`logout cancellation ${when} preserves both files`, async () => {
    const sb = sandbox();
    try {
      await store(sb).save(entry(now));
      bind(sb);
      const before = [read(sb.credentials), read(sb.binding)];
      const controller = new AbortController();
      if (when === "before invocation") controller.abort();
      const pending = logoutFor(sb, {
        signal: controller.signal,
        ...(when === "before credential removal" ||
        when === "before binding removal"
          ? {
              security: {
                directory() {},
                file(path) {
                  if (
                    when === "before credential removal" ||
                    (path === sb.credentials &&
                      !readFileSync(path, "utf8").includes("aaaaaaaaaaaaaaaa"))
                  )
                    controller.abort();
                },
              },
            }
          : {}),
      })({});
      if (when === "after lock acquisition") controller.abort();
      await expect(pending).rejects.toMatchObject({
        error: { code: "INVOCATION_CANCELLED" },
      });
      expect([read(sb.credentials), read(sb.binding)]).toEqual(before);
      await store(sb).save(entry(now));
    } finally {
      sb.close();
    }
  });

test("a held credential lock refuses logout without removing either file", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(entry(now));
    bind(sb);
    const before = [read(sb.credentials), read(sb.binding)];
    const held = openCloudFiles(sb.home).lock();
    try {
      await expect(logoutFor(sb)({})).rejects.toMatchObject({
        error: { code: "INPUT_CONFLICT" },
      });
      expect([read(sb.credentials), read(sb.binding)]).toEqual(before);
    } finally {
      held.release();
    }
  } finally {
    sb.close();
  }
});

test("binding replacement after credential removal rolls the credential back", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(entry(now));
    bind(sb);
    const before = read(sb.credentials);
    const replacement = JSON.stringify(bindingFor({ project: "other" }));
    let replaced = false;
    await expect(
      logoutFor(sb, {
        security: {
          directory() {},
          file(path) {
            if (
              !replaced &&
              path === sb.credentials &&
              !readFileSync(path, "utf8").includes("aaaaaaaaaaaaaaaa")
            ) {
              replaced = true;
              writeFileSync(sb.binding, replacement);
            }
          },
        },
      })({}),
    ).rejects.toMatchObject({ error: { code: "INPUT_CONFLICT" } });
    expect(replaced).toBe(true);
    expect(read(sb.credentials)).toBe(before);
    expect(read(sb.binding)).toBe(replacement);
  } finally {
    sb.close();
  }
});

test("logout keeps the lock until binding deletion and refuses a competing credential save", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(entry(now));
    bind(sb);
    let competing: Promise<unknown> | undefined;
    await logoutFor(sb, {
      security: {
        directory() {},
        file(path) {
          if (
            competing === undefined &&
            path === sb.credentials &&
            !readFileSync(path, "utf8").includes("aaaaaaaaaaaaaaaa")
          )
            competing = store(sb)
              .save(entry(now))
              .catch((error: unknown) => error);
        },
      },
    })({});
    expect(await competing).toMatchObject({
      error: { code: "INPUT_CONFLICT" },
    });
    expect(read(sb.binding)).toBeNull();
    expect(store(sb).associations(PROJECT_ID)).toEqual([]);
  } finally {
    sb.close();
  }
});
