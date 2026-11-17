import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createCloudLogin } from "../../src/assembly/cloud-login.ts";
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
  type Sandbox,
} from "./cloud-fixture.ts";

setDefaultTimeout(30_000);

type Run = (input: unknown) => Promise<unknown>;

function logoutFor(sb: Sandbox): Run {
  const service = createCloudLogin({
    root: sb.root,
    home: sb.home,
    deviceRoot: sb.deviceRoot,
    env: { FORGE_DEVICE_ID: "dev-1" },
    signal: new AbortController().signal,
    fetch: () => Promise.reject(new Error("logout must not use the network")),
  });
  const holder: object = service;
  return (input) => (holder as { logout: Run }).logout(input);
}

const now = clock().now();
const store = (sb: Sandbox) =>
  credentialStore(openCloudFiles(sb.home), { wait: () => Promise.resolve() });
const other = () =>
  entry(now, {
    identity: OTHER_PROJECT_ID,
    project: "other",
    id: "bbbbbbbbbbbbbbbb",
  });
const read = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, "utf8") : null;
const bind = (sb: Sandbox) =>
  writeFileSync(sb.binding, `${JSON.stringify(bindingFor(), null, 2)}\n`);

test("logout removes this project's credential and the binding, keeps other projects, and prints no secret", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(other());
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
    expect(store(sb).associations(OTHER_PROJECT_ID)).toHaveLength(1);
    expect(read(sb.credentials)).not.toContain(PROJECT_ID);
  } finally {
    sb.close();
  }
});

test("a second logout, and a logout with no binding, change nothing", async () => {
  const sb = sandbox();
  try {
    await store(sb).save(other());
    const before = read(sb.credentials);
    const expected = { status: "not-bound", tokenRevoked: false };
    expect(await logoutFor(sb)({})).toEqual(expected);
    expect(read(sb.credentials)).toBe(before);
    await store(sb).save(entry(now));
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
