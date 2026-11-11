// Cloud credentials and the project's cloud binding. Stub: behaviour lands with the fix commit.
import type { DeviceFiles } from "../ports/device-files.ts";

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

export function openCloudFiles(
  _home: string | undefined,
  _security?: {
    directory(path: string, created?: boolean): void;
    file(path: string): void;
  },
): DeviceFiles {
  throw new Error("not implemented");
}
export function parseDeviceCredential(
  _text: string,
  _wireDevice: string,
  _nowMs: number,
): DeviceCredential {
  throw new Error("not implemented");
}
export function credentialStore(
  _files: DeviceFiles,
  _options?: CredentialStoreOptions,
): CredentialStore {
  throw new Error("not implemented");
}
export function readBinding(_root: string): CloudBinding | undefined {
  throw new Error("not implemented");
}
export function writeBinding(
  _root: string,
  _binding: CloudBinding,
): "created" | "unchanged" {
  throw new Error("not implemented");
}
/** The origin and project a login targets, or a refusal when it would change an established binding. */
export function resolveTarget(
  _input: { readonly origin?: string; readonly project?: string },
  _identity: string,
  _binding: CloudBinding | undefined,
  _associations: readonly CredentialKey[],
): { readonly origin: string; readonly project: string } {
  throw new Error("not implemented");
}
