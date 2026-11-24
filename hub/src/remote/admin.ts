import { randomBytes } from "node:crypto";
import { lstat, realpath, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as ids from "../contract/ids.ts";
import type { AdminDeps, RunAdminCommand } from "../contract/runtime.ts";
import { hashSecret } from "./auth.ts";
import { flags, messages } from "./message-cli.ts";

interface PrivatePaths {
  createPrivateDirectory(path: string): Promise<boolean>;
  createPrivateFile(path: string): Promise<FileHandle | null>;
}

function refuse(reason: string, status = 1) {
  process.stderr.write(reason + "\n");
  return status;
}
const usage = () =>
  refuse("usage: forge-hub token|host create|revoke, inbox, send", 2);

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function inWorktree(dir: string) {
  for (let current = dir; ; current = dirname(current)) {
    if (await exists(join(current, ".git"))) return true;
    if (dirname(current) === current) return false;
  }
}

type Create = { person: string; label: string; output: string };
async function credential(
  token: boolean,
  values: Create,
  deps: AdminDeps,
  paths?: PrivatePaths,
) {
  const { person, label, output } = values;
  const path = resolve(output);
  const parent = dirname(path);
  let remove = false;
  try {
    if ((await exists(path)) || (await inWorktree(parent)))
      return refuse("OUTPUT_UNSAFE");
    paths ??= await import("../core/index.ts");
    if (
      !(await exists(parent)) &&
      !(await paths.createPrivateDirectory(parent))
    )
      return refuse("OUTPUT_PARENT_UNSAFE");
    if (
      !deps.protectPath(parent, "dir") ||
      relative(parent, await realpath(parent))
    )
      return refuse("OUTPUT_PARENT_UNSAFE");
    const handle = await paths.createPrivateFile(path);
    if (!handle) return refuse("OUTPUT_UNSAFE");
    remove = true;
    let hash: string;
    try {
      const prefix = token ? ids.TOKEN_PREFIX : ids.HOST_KEY_PREFIX;
      const secret = prefix + randomBytes(32).toString("base64url");
      await handle.writeFile((token ? "FORGE_HUB_TOKEN=" : "") + secret + "\n");
      hash = hashSecret(secret);
    } finally {
      await handle.close();
    }
    const { core } = deps;
    const id = token
      ? core.createToken(person, label, hash)?.tokenId
      : core.createHostKey(person, label, hash)?.hostInstanceId;
    if (!id) return refuse("PERSON_UNKNOWN");
    remove = false;
    process.stdout.write(id + " " + path + "\n");
    return 0;
  } catch {
    return refuse("CREDENTIAL_UNAVAILABLE");
  } finally {
    if (remove) await unlink(path).catch(() => undefined);
  }
}

export const runAdminCommand: RunAdminCommand = adminWith;
export async function adminWith(
  argv: readonly string[],
  deps: AdminDeps,
  paths?: PrivatePaths,
) {
  const [kind, action, ...args] = argv;
  try {
    if (kind === "inbox" || kind === "send")
      return await messages(kind, argv.slice(1), deps);
    if (kind !== "token" && kind !== "host") return usage();
    const create = action === "create";
    if (!create && action !== "revoke") return usage();
    const token = kind === "token";
    const block = token ? "mcp" : "hooks";
    if (create && !deps.config[block].enabled)
      return refuse("BLOCK_DISABLED: " + block);
    if (create) {
      const { values } = parseArgs({
        args,
        options: flags("person", "label", "output", "config"),
      });
      const { person, label, output } = values;
      if (!person || !label || !output) return usage();
      return await credential(token, { person, label, output }, deps, paths);
    }
    const { positionals } = parseArgs({
      args,
      options: flags("config"),
      allowPositionals: true,
    });
    const [id] = positionals;
    const prefix = token ? ids.ID_PREFIX.token : ids.ID_PREFIX.hostInstance;
    if (
      positionals.length !== 1 ||
      !id?.startsWith(prefix + "_") ||
      !ids.ID_PATTERN.test(id)
    )
      return usage();
    const { core } = deps;
    const revoked = token ? core.revokeToken(id) : core.revokeHostKey(id);
    process.stdout.write(revoked ? "revoked\n" : "not found\n");
    return revoked ? 0 : 1;
  } catch {
    return usage();
  }
}
