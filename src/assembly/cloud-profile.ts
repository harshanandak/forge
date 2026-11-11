// Cloud credentials and the project's cloud binding.
//
// The credential file maps (origin, project UUID, project name) to the device token the Worker issued.
// It is a private device file: a token is read back only under its exact key, so a repository file
// that names another origin or project can never cause a saved token to be sent there. The binding
// (.forge/cloud.json) holds no secret; it is written only after the credential has read back.
import { entryKind, nodeConfigFiles } from "../adapters/fs/index.ts";
import { createDeviceFiles } from "../adapters/fs/device-identity.ts";
import { validateOrigin, validateProject } from "../adapters/http/index.ts";
import { windowsPrivateFiles } from "../adapters/process/windows-acl.ts";
import { privateFileGuard } from "../adapters/store-sqlite/private-files.ts";
import { ForgeFailure } from "../contract/failure.ts";
import type { DeviceFiles } from "../ports/device-files.ts";
import { PROJECT_ID_PATTERN } from "./project-manifest.ts";

export const CREDENTIAL_FILE = "credentials.json";
export const BINDING_PATH = ".forge/cloud.json";

/** A saved credential is found only by all three: the exact origin, project UUID and project name. */
export interface CredentialKey {
  readonly origin: string;
  readonly identity: string;
  readonly project: string;
}
/** What the Worker issued; `expiresAt` is the ISO-8601 string it sends. */
export interface DeviceCredential {
  readonly id: string;
  readonly token: string;
  readonly device: string;
  readonly expiresAt: string;
}
export interface CredentialEntry extends CredentialKey, DeviceCredential {
  /** The device id this machine holds locally; `device` is the id sent to the Worker. */
  readonly localDevice: string;
}
export interface CloudBinding {
  readonly schema: 1;
  readonly identity: string;
  readonly origin: string;
  readonly project: string;
}
export interface CredentialStore {
  lookup(key: CredentialKey, nowMs: number): DeviceCredential | undefined;
  associations(identity: string): readonly CredentialKey[];
  save(entry: CredentialEntry): Promise<void>;
}
export interface CredentialStoreOptions {
  /** Pauses between attempts to take the file lock. */
  readonly wait?: (ms: number) => Promise<void>;
  readonly attempts?: number;
}
type PrivateChecks = {
  directory(path: string, created?: boolean): void;
  file(path: string): void;
};

const DAY_MS = 86_400_000;
const FILE_LIMIT = 1_048_576;
const BINDING_LIMIT = 4_096;
const WIRE_DEVICE = /^[A-Za-z0-9][\w.:-]{0,127}$/;
const LOCAL_DEVICE = /^[^\s/\\]{1,256}$/;
const TOKEN_ID = /^[0-9a-f]{16}$/;
const TOKEN = /^fct_([0-9a-f]{16})\.[A-Za-z0-9_-]{43}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORMAT = "forge/device-credential/1";

const integrity = (): ForgeFailure =>
  new ForgeFailure({
    code: "ACCOUNT_INTEGRITY",
    message:
      "The cloud credential file failed integrity checks and was left as it is",
    retry: "never",
    repair:
      "Check ~/.forge/cloud/credentials.json is yours and private, or remove it and log in again.",
  });
const unusable = (): ForgeFailure =>
  new ForgeFailure({
    code: "UNAVAILABLE",
    message: "The Forge cloud returned a credential that failed its checks",
    retry: "never",
  });
const conflict = (message: string): ForgeFailure =>
  new ForgeFailure({
    code: "INPUT_CONFLICT",
    message,
    retry: "never",
    repair:
      "An established cloud binding is never changed by login; ask the owner to move it deliberately.",
  });
const invalidInput = (message: string): ForgeFailure =>
  new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const exactly = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
/** Milliseconds of an ISO string that round-trips exactly, or undefined. */
function isoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value
    ? ms
    : undefined;
}
const keyOf = (key: CredentialKey): string =>
  `${key.origin}|${key.identity}|${key.project}`;

/** The home's cloud folder as private device files, with the host's native checks on Windows. */
export function openCloudFiles(
  home: string | undefined,
  security?: PrivateChecks,
): DeviceFiles {
  if (home === undefined || home === "")
    throw new ForgeFailure({
      code: "UNAVAILABLE",
      message: "Cloud credentials need a home directory",
      retry: "never",
    });
  let guard: ReturnType<typeof privateFileGuard> | undefined;
  const host: PrivateChecks | undefined =
    security ??
    (process.platform === "win32"
      ? {
          directory(path, created) {
            guard ??= privateFileGuard(windowsPrivateFiles());
            guard.directory(path, created);
          },
          file(path) {
            guard ??= privateFileGuard(windowsPrivateFiles());
            guard.file(path);
          },
        }
      : undefined);
  return createDeviceFiles(home, host, "cloud");
}

/** Parse and check the Worker's credential string; the token is never quoted in a failure. */
export function parseDeviceCredential(
  text: string,
  wireDevice: string,
  nowMs: number,
): DeviceCredential {
  let value: Record<string, unknown> | undefined;
  try {
    value = record(JSON.parse(text));
  } catch {
    throw unusable();
  }
  if (
    value === undefined ||
    !exactly(value, ["format", "id", "token", "device", "expiresAt"]) ||
    value.format !== FORMAT ||
    typeof value.id !== "string" ||
    !TOKEN_ID.test(value.id) ||
    typeof value.token !== "string" ||
    TOKEN.exec(value.token)?.[1] !== value.id ||
    value.device !== wireDevice
  )
    throw unusable();
  const expires = isoMs(value.expiresAt);
  if (
    expires === undefined ||
    expires <= nowMs ||
    expires > nowMs + 91 * DAY_MS
  )
    throw unusable();
  return {
    id: value.id,
    token: value.token,
    device: wireDevice,
    expiresAt: value.expiresAt as string,
  };
}

/** One stored entry, or an integrity failure; its key must be the one it is stored under. */
function parseEntry(key: string, value: unknown): CredentialEntry {
  const fields = record(value);
  if (
    fields === undefined ||
    !exactly(fields, [
      "origin",
      "identity",
      "project",
      "localDevice",
      "device",
      "id",
      "token",
      "expiresAt",
    ])
  )
    throw integrity();
  const {
    origin,
    identity,
    project,
    localDevice,
    device,
    id,
    token,
    expiresAt,
  } = fields;
  try {
    if (
      typeof origin !== "string" ||
      typeof project !== "string" ||
      validateOrigin(origin) !== origin ||
      validateProject(project) !== project ||
      typeof identity !== "string" ||
      !PROJECT_ID_PATTERN.test(identity) ||
      typeof localDevice !== "string" ||
      !LOCAL_DEVICE.test(localDevice) ||
      typeof device !== "string" ||
      !WIRE_DEVICE.test(device) ||
      typeof id !== "string" ||
      !TOKEN_ID.test(id) ||
      typeof token !== "string" ||
      TOKEN.exec(token)?.[1] !== id ||
      typeof expiresAt !== "string" ||
      isoMs(expiresAt) === undefined ||
      keyOf({ origin, identity, project }) !== key
    )
      throw integrity();
  } catch {
    throw integrity();
  }
  return {
    origin,
    identity,
    project,
    localDevice,
    device,
    id,
    token,
    expiresAt,
  };
}

function parseFile(text: string): Record<string, CredentialEntry> {
  let value: Record<string, unknown> | undefined;
  try {
    value = record(JSON.parse(text));
  } catch {
    throw integrity();
  }
  const entries = record(value?.entries);
  if (
    value === undefined ||
    !exactly(value, ["schema", "entries"]) ||
    value.schema !== 1 ||
    entries === undefined
  )
    throw integrity();
  const map: Record<string, CredentialEntry> = {};
  for (const [key, entry] of Object.entries(entries))
    map[key] = parseEntry(key, entry);
  return map;
}
function serialize(map: Readonly<Record<string, CredentialEntry>>): string {
  const entries: Record<string, CredentialEntry> = {};
  for (const key of Object.keys(map).sort()) entries[key] = map[key]!;
  return `${JSON.stringify({ schema: 1, entries }, null, 2)}\n`;
}

export function credentialStore(
  files: DeviceFiles,
  options: CredentialStoreOptions = {},
): CredentialStore {
  const attempts = options.attempts ?? 20;
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const load = (): Record<string, CredentialEntry> => {
    const text = files.read(CREDENTIAL_FILE);
    return text === undefined ? {} : parseFile(text);
  };

  /** Never held while waiting for approval: taken only to merge one verified entry. */
  async function lock(): Promise<{ release(): void }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return files.lock();
      } catch (error) {
        if (
          !(error instanceof ForgeFailure) ||
          error.error.code !== "INPUT_CONFLICT" ||
          attempt >= attempts
        )
          throw error;
        await wait(100);
      }
    }
  }

  return {
    lookup(key, nowMs) {
      const found = load()[keyOf(key)];
      if (found === undefined || Date.parse(found.expiresAt) <= nowMs)
        return undefined;
      return {
        id: found.id,
        token: found.token,
        device: found.device,
        expiresAt: found.expiresAt,
      };
    },
    associations(identity) {
      return Object.values(load())
        .filter((entry) => entry.identity === identity)
        .map(({ origin, project }) => ({ origin, identity, project }));
    },
    async save(entry) {
      const held = await lock();
      let previous: string | undefined;
      let published = false;
      try {
        previous = files.read(CREDENTIAL_FILE);
        const merged = {
          ...(previous === undefined ? {} : parseFile(previous)),
          [keyOf(entry)]: parseEntry(keyOf(entry), entry),
        };
        const text = serialize(merged);
        if (Buffer.byteLength(text) > FILE_LIMIT) throw integrity();
        parseFile(text);
        files.write(CREDENTIAL_FILE, text);
        published = true;
        if (files.read(CREDENTIAL_FILE) !== text) throw integrity();
      } catch (error) {
        if (published && previous !== undefined) {
          // The new document did not read back: put the previous valid one back, and check that too.
          try {
            files.write(CREDENTIAL_FILE, previous, { force: true });
            if (files.read(CREDENTIAL_FILE) !== previous) throw integrity();
          } catch {
            throw new ForgeFailure({
              code: "ACCOUNT_INTEGRITY",
              message:
                "The new cloud credential did not read back and the previous one could not be restored",
              retry: "never",
              repair:
                "Remove ~/.forge/cloud/credentials.json and log in again.",
            });
          }
        }
        throw error instanceof ForgeFailure
          ? error
          : new ForgeFailure({
              code: "UNAVAILABLE",
              message: "The cloud credential could not be saved",
              retry: "never",
            });
      } finally {
        held.release();
      }
    },
  };
}

function parseBinding(bytes: Uint8Array): CloudBinding {
  let value: Record<string, unknown> | undefined;
  try {
    value = record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw invalidInput(`${BINDING_PATH} is not valid JSON`);
  }
  if (
    value === undefined ||
    !exactly(value, ["schema", "identity", "origin", "project"])
  )
    throw invalidInput(
      `${BINDING_PATH} must be an object with only schema, identity, origin and project`,
    );
  const { schema, identity, origin, project } = value;
  if (
    schema !== 1 ||
    typeof identity !== "string" ||
    !PROJECT_ID_PATTERN.test(identity) ||
    typeof origin !== "string" ||
    typeof project !== "string"
  )
    throw invalidInput(`${BINDING_PATH} has a field that is not valid`);
  return {
    schema: 1,
    identity,
    origin: validateOrigin(origin),
    project: validateProject(project),
  };
}

/** The committed binding, undefined when absent; a malformed or unsafe one fails closed. */
export function readBinding(root: string): CloudBinding | undefined {
  let bytes: Uint8Array | undefined;
  try {
    const kind = entryKind(root, BINDING_PATH);
    if (kind === "missing") return undefined;
    if (kind !== "file") throw new Error("not a plain file");
    bytes = nodeConfigFiles(root).read(BINDING_PATH, BINDING_LIMIT);
  } catch {
    throw invalidInput(
      `${BINDING_PATH} is not a plain file Forge can read safely`,
    );
  }
  return bytes === undefined ? undefined : parseBinding(bytes);
}

/** Create the binding once. An identical existing one is fine; any other is never changed. */
export function writeBinding(
  root: string,
  binding: CloudBinding,
): "created" | "unchanged" {
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(binding, null, 2)}\n`,
  );
  let created: boolean;
  try {
    created = nodeConfigFiles(root).createExclusive(BINDING_PATH, bytes);
  } catch {
    throw invalidInput(`${BINDING_PATH} could not be written safely`);
  }
  if (created) return "created";
  const existing = readBinding(root);
  if (
    existing?.identity === binding.identity &&
    existing.origin === binding.origin &&
    existing.project === binding.project
  )
    return "unchanged";
  throw conflict(`${BINDING_PATH} already binds this project elsewhere`);
}

/** The origin and project a login targets, or a refusal when it would change an established binding. */
export function resolveTarget(
  input: { readonly origin?: string; readonly project?: string },
  identity: string,
  binding: CloudBinding | undefined,
  associations: readonly CredentialKey[],
): { readonly origin: string; readonly project: string } {
  const pairs = new Map(
    associations.map((a) => [`${a.origin}|${a.project}`, a] as const),
  );
  const established =
    binding !== undefined
      ? binding
      : pairs.size === 1
        ? [...pairs.values()][0]
        : undefined;
  if (binding !== undefined && binding.identity !== identity)
    throw conflict(`${BINDING_PATH} belongs to a different project identity`);
  if (
    pairs.size > 1 ||
    (binding !== undefined &&
      [...pairs.values()].some(
        (a) => a.origin !== binding.origin || a.project !== binding.project,
      ))
  )
    throw conflict(
      "The saved cloud credentials and the binding name different servers or projects",
    );
  if (established === undefined) {
    if (input.origin === undefined || input.project === undefined)
      throw invalidInput(
        "The first login needs --origin and --project to say which Forge cloud project to bind",
      );
    return { origin: input.origin, project: input.project };
  }
  if (
    (input.origin !== undefined && input.origin !== established.origin) ||
    (input.project !== undefined && input.project !== established.project)
  )
    throw conflict(
      "This project is already bound to another Forge cloud origin or project",
    );
  return { origin: established.origin, project: established.project };
}
