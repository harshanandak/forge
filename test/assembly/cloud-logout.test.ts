import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  createCloudLogin,
  type CloudLoginDeps,
} from "../../src/assembly/cloud-login.ts";
import {
  CREDENTIAL_FILE,
  credentialStore,
  openCloudFiles,
} from "../../src/assembly/cloud-profile.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  approved,
  bindingFor,
  clock,
  credentialJson,
  entry,
  json,
  network,
  ORIGIN,
  OTHER_PROJECT_ID,
  PROJECT,
  PROJECT_ID,
  sandbox,
  SECRET,
  startBody,
  tokenFor,
  type Sandbox,
} from "./cloud-fixture.ts";

setDefaultTimeout(30_000);

function serviceFor(sb: Sandbox, overrides: Partial<CloudLoginDeps> = {}) {
  return createCloudLogin({
    root: sb.root,
    home: sb.home,
    deviceRoot: sb.deviceRoot,
    env: { FORGE_DEVICE_ID: "dev-1" },
    signal: new AbortController().signal,
    fetch: () => Promise.reject(new Error("logout must not use the network")),
    ...overrides,
  });
}

const logoutFor = (sb: Sandbox) => (input: unknown) =>
  serviceFor(sb).logout(input);

const now = clock().now();
const store = (sb: Sandbox) =>
  credentialStore(openCloudFiles(sb.home), { wait: () => Promise.resolve() });
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
        observed: { tokenId: "aaaaaaaaaaaaaaaa" },
      },
    });
    expect(read(sb.binding)).toBe(replacement);
    expect(read(sb.credentials)).toBe(before);
  } finally {
    sb.close();
  }
});

test.each(["login", "logout"] as const)(
  "%s keeps its credential write and binding change under the same lock",
  async (operation) => {
    const sb = sandbox();
    try {
      const observer = openCloudFiles(sb.home);
      if (operation === "logout") {
        await store(sb).save(entry(now));
        bind(sb);
      } else observer.lock().release();
      const before = read(sb.credentials);
      const seen: unknown[] = [];
      const clk = clock();
      const net = network(
        () => json(startBody()),
        () => approved(credentialJson(clk.now())),
      );
      const service = serviceFor(sb, {
        env: { FORGE_DEVICE_ID: "dev-1", FORGE_NO_BROWSER: "1" },
        fetch: net.fetch,
        now: clk.now,
        wait: (ms, signal) => clk.wait(ms, signal),
        progress: () => {},
        security: {
          directory: () => {},
          file(path) {
            if (basename(path) !== CREDENTIAL_FILE || read(path) === before)
              return;
            queueMicrotask(() => {
              try {
                const held = observer.lock();
                try {
                  const saved = store(sb).lookup(bindingFor(), now);
                  seen.push((saved !== undefined) === existsSync(sb.binding));
                } finally {
                  held.release();
                }
              } catch (error) {
                seen.push(
                  error instanceof ForgeFailure &&
                    error.error.code === "INPUT_CONFLICT"
                    ? true
                    : error,
                );
              }
            });
          },
        },
      });
      if (operation === "login")
        await service.login({ origin: ORIGIN, project: PROJECT });
      else await service.logout({});
      expect(seen).toEqual([true]);
      expect(existsSync(sb.binding)).toBe(operation === "login");
      expect(store(sb).lookup(bindingFor(), now) !== undefined).toBe(
        operation === "login",
      );
    } finally {
      sb.close();
    }
  },
);

test("logout cancelled while waiting for the credential lock changes neither file", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(entry(now));
    bind(sb);
    const credentials = read(sb.credentials);
    const binding = read(sb.binding);
    const abort = new AbortController();
    const held = openCloudFiles(sb.home).lock();
    const result = serviceFor(sb, { signal: abort.signal }).logout({});
    abort.abort();
    held.release();
    await expect(result).rejects.toMatchObject({
      error: { code: "INVOCATION_CANCELLED" },
    });
    expect(read(sb.credentials)).toBe(credentials);
    expect(read(sb.binding)).toBe(binding);
  } finally {
    sb.close();
  }
});

test.each(["binding change", "cancellation"] as const)(
  "logout restores its credential when %s interrupts binding removal",
  async (interruption) => {
    const sb = sandbox();
    try {
      await store(sb).save(entry(now));
      bind(sb);
      const credentials = read(sb.credentials);
      const binding = read(sb.binding);
      const replacement = `${JSON.stringify(bindingFor({ project: "other" }))}\n`;
      const abort = new AbortController();
      let interrupted = false;
      const result = serviceFor(sb, {
        signal: abort.signal,
        security: {
          directory: () => {},
          file(path) {
            if (
              interrupted ||
              basename(path) !== CREDENTIAL_FILE ||
              read(path) === credentials
            )
              return;
            interrupted = true;
            if (interruption === "binding change")
              writeFileSync(sb.binding, replacement);
            else abort.abort();
          },
        },
      }).logout({});
      await expect(result).rejects.toMatchObject({
        error: {
          code:
            interruption === "binding change"
              ? "INPUT_CONFLICT"
              : "INVOCATION_CANCELLED",
        },
      });
      expect(interrupted).toBe(true);
      expect(read(sb.credentials)).toBe(credentials);
      expect(read(sb.binding)).toBe(
        interruption === "binding change" ? replacement : binding,
      );
    } finally {
      sb.close();
    }
  },
);

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
