import { randomBytes } from "node:crypto";
import { ID_PREFIX, type IdKind } from "../contract/ids.ts";
import type { CredentialStore, StoreDeps } from "./store.ts";

export function newStoreId(kind: IdKind): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const suffix = Array.from(randomBytes(20), (byte) =>
    alphabet.charAt(byte & 31),
  ).join("");
  return ID_PREFIX[kind] + "_" + suffix;
}

type Deps = Pick<StoreDeps, "db" | "people" | "now">;

export function createCredentialStore(deps: Deps): CredentialStore {
  const { db, people, now } = deps;
  const hasPerson = (id: string) => people.byPersonId(id) !== undefined;
  function credentials(table: "tokens" | "host_keys") {
    const token = table === "tokens";
    const id = token ? "token_id" : "host_instance_id";
    const hash = token ? "token_hash" : "key_hash";
    const kind = token ? "token" : "hostInstance";
    const byHash =
      db.prepare(`SELECT ${id} AS id, person_id, label, ${hash} AS hash
      FROM ${table} WHERE ${hash} = ? AND revoked_at IS NULL`);
    const insert = db.prepare(
      `INSERT INTO ${table} (${id}, person_id, label, ${hash}, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const update = db.prepare(
      `UPDATE ${table} SET last_used_at = ? WHERE ${id} = ?`,
    );
    const revoke = db.prepare(
      `UPDATE ${table} SET revoked_at = ? WHERE ${id} = ? AND revoked_at IS NULL`,
    );
    return {
      add(personId: string, label: string, hash: string) {
        if (!hasPerson(personId)) return undefined;
        const credentialId = newStoreId(kind);
        insert.run(credentialId, personId, label, hash, now());
        return { id: credentialId, personId, label, hash };
      },
      find(hash: string) {
        return db.transaction(() => {
          const row = byHash.get(hash);
          if (!row) return undefined;
          const { id, person_id: personId, label, hash: stored } = row;
          if (
            typeof id !== "string" ||
            typeof personId !== "string" ||
            typeof label !== "string" ||
            typeof stored !== "string"
          )
            throw new Error("Invalid hub credential row.");
          if (!hasPerson(personId)) return undefined;
          update.run(now(), id);
          return { id, personId, label, hash: stored };
        });
      },
      revoke: (id: string) => revoke.run(now(), id).changes > 0,
    };
  }

  const tokens = credentials("tokens");
  const hosts = credentials("host_keys");
  const current = db.prepare(`
    SELECT person_id FROM tokens WHERE token_id = ? AND revoked_at IS NULL
  `);
  function token(record: ReturnType<typeof tokens.add>) {
    if (!record) return undefined;
    const { id, hash, ...rest } = record;
    return { ...rest, tokenId: id, tokenHash: hash };
  }
  function host(record: ReturnType<typeof hosts.add>) {
    if (!record) return undefined;
    const { id, hash, ...rest } = record;
    return { ...rest, hostInstanceId: id, keyHash: hash };
  }
  return {
    createToken: (...args) => token(tokens.add(...args)),
    revokeToken: tokens.revoke,
    findToken: (hash) => token(tokens.find(hash)),
    isTokenCurrent(id) {
      const personId = current.get(id)?.person_id;
      return typeof personId === "string" && hasPerson(personId);
    },
    createHostKey: (...args) => host(hosts.add(...args)),
    revokeHostKey: hosts.revoke,
    findHostKey: (hash) => host(hosts.find(hash)),
  };
}
