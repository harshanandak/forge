import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as fsAdapter from "../../src/adapters/fs/index.ts";
import {
  createCloudLogin,
  type CloudLoginDeps,
} from "../../src/assembly/cloud-login.ts";
import {
  BINDING_PATH,
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

function logoutFor(sb: Sandbox, more: Partial<CloudLoginDeps> = {}) {
  const service = createCloudLogin({
    root: sb.root,
    home: sb.home,
    deviceRoot: sb.deviceRoot,
    env: { FORGE_DEVICE_ID: "dev-1" },
    signal: new AbortController().signal,
    fetch: () => Promise.reject(new Error("logout must not use the network")),
    ...more,
  });
  return (input: unknown) => service.logout(input);
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
    const expected = { status: "not-bound", tokenRevoked: false } as const;
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
    const before = read(sb.credentials);
    const replacement = `${JSON.stringify(bindingFor({ project: "other" }))}\n`;
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

test("logout cancelled at lock acquisition keeps the credential and binding", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(entry(now));
    bind(sb);
    const before = [read(sb.credentials), read(sb.binding)];
    const controller = new AbortController();
    const logout = logoutFor(sb, { signal: controller.signal });
    const result = logout({});
    controller.abort();
    await expect(result).rejects.toMatchObject({
      error: { code: "INVOCATION_CANCELLED" },
    });
    expect([read(sb.credentials), read(sb.binding)]).toEqual(before);
    openCloudFiles(sb.home).lock().release();
  } finally {
    sb.close();
  }
});

test("logout checks cancellation after writing the credential and restores it if binding removal has not started", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(entry(now));
    bind(sb);
    const before = [read(sb.credentials), read(sb.binding)];
    const controller = new AbortController();
    const logout = logoutFor(sb, {
      signal: controller.signal,
      security: {
        directory() {},
        file(path) {
          if (path === sb.credentials && read(path) !== before[0])
            controller.abort();
        },
      },
    });
    await expect(logout({})).rejects.toMatchObject({
      error: { code: "INVOCATION_CANCELLED" },
    });
    expect([read(sb.credentials), read(sb.binding)]).toEqual(before);
  } finally {
    sb.close();
  }
});

test("logout holds the lock during binding removal and restores the credential after a late edit", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(entry(now));
    bind(sb);
    const before = read(sb.credentials);
    const replacement = `${JSON.stringify(bindingFor({ project: "other" }))}\n`;
    const configFiles = fsAdapter.nodeConfigFiles;
    let conflict: unknown;
    const config = spyOn(fsAdapter, "nodeConfigFiles").mockImplementation(
      (...args) => {
        const files = configFiles(...args);
        return {
          ...files,
          remove(path, expected, options) {
            if (path === BINDING_PATH) {
              try {
                openCloudFiles(sb.home).lock().release();
              } catch (error) {
                conflict = error;
              }
              writeFileSync(sb.binding, replacement);
            }
            files.remove(path, expected, options);
          },
        };
      },
    );
    try {
      await expect(logoutFor(sb)({})).rejects.toMatchObject({
        error: { code: "INPUT_CONFLICT", retry: "reconcile_first" },
      });
    } finally {
      config.mockRestore();
    }
    expect(conflict).toMatchObject({ error: { code: "INPUT_CONFLICT" } });
    expect(read(sb.credentials)).toBe(before);
    expect(read(sb.binding)).toBe(replacement);
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
