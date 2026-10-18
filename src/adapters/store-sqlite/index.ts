import {
  realpathSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  copyFileSync,
  rmSync,
  existsSync,
  statSync,
  fstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { inspectRecoveryFile } from "./recovery.ts";
import type { StateImageStore } from "../../core/state/index.ts";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  StorePort,
  SqlDatabase,
  SqlValue,
  SqlRow,
} from "../../ports/store.ts";
import { assertFilesystem } from "../../core/state/fs-class.ts";

interface Binding {
  exec(sql: string): unknown;
  prepare(sql: string): {
    setReadBigInts?(enabled: boolean): void;
    finalize?(): void;
    run(...params: SqlValue[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    get(...params: SqlValue[]): unknown;
    all(...params: SqlValue[]): unknown[];
  };
  close(): void;
}

function realStorePath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new Error("Dangling store symlink is refused", { cause: error });
    } catch (entryError) {
      if ((entryError as NodeJS.ErrnoException).code !== "ENOENT")
        throw entryError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(realStorePath(parent), basename(path));
  }
}

/** Hosts may bind relative store paths to an explicit absolute base directory. */
export interface RestoreHooks {
  readonly step?: (step: string) => void;
}

export function createSqliteStore(
  basePath: string,
  hooks: RestoreHooks = {},
): StorePort {
  if (!isAbsolute(basePath)) throw new Error("Store base must be absolute");
  return {
    async open(options) {
      let binding: Binding | undefined;
      let pinned: number | undefined;
      try {
        const path =
          options.path === ":memory:"
            ? options.path
            : realStorePath(resolve(basePath, options.path));
        assertFilesystem(
          {
            path,
            platform: process.platform,
            cloudRoots: [
              process.env.OneDrive,
              process.env.OneDriveConsumer,
              process.env.OneDriveCommercial,
              process.env.Dropbox,
            ]
              .filter((value): value is string => Boolean(value))
              .map((root) => realStorePath(resolve(basePath, root))),
          },
          (message) => {
            process.stderr.write(message);
          },
        );
        const fencePath = `${path}.restore-lock`;
        const assertUnfenced = (): void => {
          if (path !== ":memory:" && existsSync(fencePath))
            throw new Error("Store is fenced for restore");
        };
        assertUnfenced();
        const expectedIdentity =
          path === ":memory:" || !existsSync(path)
            ? undefined
            : statSync(path, { bigint: true });
        hooks.step?.("identity-checked");
        // Keep the opened inode pinned across SQLite's open; reject either side
        // of a pathname replacement rather than adopting its newer identity.
        if (path !== ":memory:")
          pinned = openSync(path, options.readOnly ? "r" : "a+");
        hooks.step?.("opening");
        let connect: (path: string, readOnly: boolean) => Binding;
        if ("Bun" in globalThis) {
          // A variable specifier keeps the Node-only declaration build independent of Bun types.
          const specifier = "bun:sqlite";
          const runtime = (await import(specifier)) as {
            Database: new (
              path: string,
              options: {
                readonly: boolean;
                create: boolean;
                safeIntegers: boolean;
              },
            ) => Binding;
          };
          connect = (name, readOnly) =>
            new runtime.Database(name, {
              readonly: readOnly,
              create: !readOnly,
              safeIntegers: true,
            });
          binding = connect(path, options.readOnly);
        } else {
          const { DatabaseSync } = await import("node:sqlite");
          connect = (name, readOnly) => new DatabaseSync(name, { readOnly });
          binding = connect(path, options.readOnly);
        }
        let db = binding;
        hooks.step?.("connected");
        let identity =
          pinned === undefined
            ? undefined
            : fstatSync(pinned, { bigint: true });
        const current =
          path === ":memory:" ? undefined : statSync(path, { bigint: true });
        assertUnfenced();
        if (
          identity &&
          current &&
          ((expectedIdentity !== undefined &&
            (identity.dev !== expectedIdentity.dev ||
              identity.ino !== expectedIdentity.ino)) ||
            identity.dev !== current.dev ||
            identity.ino !== current.ino)
        )
          throw new Error(
            "Store identity changed while opening; reopen required",
          );
        if (pinned !== undefined) {
          closeSync(pinned);
          pinned = undefined;
        }
        let restoring = false;
        let ownsFence = false;
        let memoryDirectory: string | undefined;
        const syncFile = (name: string): void => {
          const fd = openSync(name, "r+");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        };
        const syncDirectory = (): void => {
          // Windows does not expose directory fsync through node:fs.
          if (process.platform === "win32" || path === ":memory:") return;
          const fd = openSync(dirname(path), "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        };
        const wrap = (raw: Binding): SqlDatabase => ({
          exec(sql) {
            raw.exec(sql);
          },
          run(sql, params = []) {
            const statement = raw.prepare(sql);
            statement.setReadBigInts?.(true);
            try {
              const result = statement.run(...params);
              return {
                changes: Number(result.changes),
                lastInsertRowid: result.lastInsertRowid,
              };
            } finally {
              statement.finalize?.();
            }
          },
          get(sql, params = []) {
            const statement = raw.prepare(sql);
            statement.setReadBigInts?.(true);
            try {
              return (statement.get(...params) ?? undefined) as
                SqlRow | undefined;
            } finally {
              statement.finalize?.();
            }
          },
          all(sql, params = []) {
            const statement = raw.prepare(sql);
            statement.setReadBigInts?.(true);
            try {
              return statement.all(...params) as SqlRow[];
            } finally {
              statement.finalize?.();
            }
          },
          transaction(body) {
            raw.exec("BEGIN IMMEDIATE");
            try {
              const result = body();
              raw.exec("COMMIT");
              return result;
            } catch (error) {
              raw.exec("ROLLBACK");
              throw error;
            }
          },
        });
        const check = (candidate: SqlDatabase): void => {
          const rows = candidate.all("PRAGMA integrity_check");
          if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
            throw new Error("Snapshot integrity check failed");
          if (candidate.all("PRAGMA foreign_key_check").length)
            throw new Error("Snapshot violates foreign key constraints");
        };
        const prepare = (sql: string): ReturnType<Binding["prepare"]> => {
          const statement = db.prepare(sql);
          statement.setReadBigInts?.(true);
          return statement;
        };
        db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
        let closed = false;
        let active = false;
        const assertOpen = (): void => {
          if (closed) throw new Error("Store is closed");
          if (
            restoring ||
            (path !== ":memory:" && !ownsFence && existsSync(fencePath))
          )
            throw new Error("Store is fenced for restore");
          if (identity) {
            const current = statSync(path, { bigint: true });
            if (identity.dev !== current.dev || identity.ino !== current.ino)
              throw new Error("Store identity changed; reopen required");
          }
        };
        const value: StateImageStore = {
          exportImage(inspect) {
            assertOpen();
            if (active) throw new Error("Cannot export during a transaction");
            const directory = mkdtempSync(join(tmpdir(), ".forge-export-"));
            const destination = join(directory, "snapshot.db");
            try {
              // SQLite creates a consistent complete image, including WAL contents, without INSERT replay.
              db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
              const captured = connect(destination, true);
              try {
                inspect?.(wrap(captured));
              } finally {
                captured.close();
              }
              return new Uint8Array(readFileSync(destination));
            } finally {
              rmSync(directory, { recursive: true, force: true });
            }
          },
          restoreImage(image, validate, prepareCandidate, verify) {
            assertOpen();
            if (options.readOnly || active)
              throw new Error("Restore requires an idle writable store");
            const memory = path === ":memory:";
            const directory = memory
              ? mkdtempSync(join(tmpdir(), ".forge-restore-"))
              : dirname(path);
            const candidatePath = join(
              directory,
              `.restore-${randomUUID()}.db`,
            );
            const previousPath = `${path}.previous-${randomUUID()}`;
            let candidate: Binding | undefined;
            let lock: number | undefined;
            let swapped = false;
            let liveClosed = false;
            let previous = false;
            let releaseFence = true;
            const priorDb = db;
            const priorMemoryDirectory = memoryDirectory;
            const step = (name: string): void => {
              hooks.step?.(name);
            };
            try {
              writeFileSync(candidatePath, image, { flag: "wx", mode: 0o600 });
              step("written");
              syncFile(candidatePath);
              step("synced");
              candidate = connect(candidatePath, true);
              check(wrap(candidate));
              validate(wrap(candidate));
              candidate.close();
              candidate = undefined;
              step("validated");
              candidate = connect(candidatePath, false);
              candidate.exec("PRAGMA foreign_keys=ON");
              prepareCandidate(wrap(candidate));
              check(wrap(candidate));
              candidate.close();
              candidate = undefined;
              syncFile(candidatePath);
              const approvedCandidate = inspectRecoveryFile(candidatePath);
              step("prepared");
              if (!memory) {
                lock = openSync(fencePath, "wx", 0o600);
                ownsFence = true;
                fsyncSync(lock);
              }
              // A writer lock prevents other SQLite writers changing the target during final approval.
              db.exec("BEGIN EXCLUSIVE");
              try {
                verify();
                step("fenced");
              } catch (error) {
                db.exec("ROLLBACK");
                throw error;
              }
              db.exec("COMMIT");
              restoring = true;
              if (memory) {
                candidate = connect(candidatePath, false);
                liveClosed = true;
                db = candidate;
                candidate = undefined;
                swapped = true;
                memoryDirectory = directory;
              } else {
                db.close();
                liveClosed = true;
                step("closed");
                if (
                  ["-wal", "-shm", "-journal"].some((suffix) =>
                    existsSync(`${path}${suffix}`),
                  )
                )
                  throw new Error(
                    "Other store connections or sidecars prevent replacement",
                  );
                copyFileSync(path, previousPath);
                previous = true;
                syncFile(previousPath);
                syncDirectory();
                step("retained");
                const currentCandidate = inspectRecoveryFile(candidatePath);
                if (
                  JSON.stringify(currentCandidate) !==
                  JSON.stringify(approvedCandidate)
                )
                  throw new Error("Candidate identity drift before swap");
                renameSync(candidatePath, path);
                swapped = true;
                syncDirectory();
                step("renamed");
                db = connect(path, false);
              }
              db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
              check(wrap(db));
              validate(wrap(db));
              step("verified");
              if (!memory) identity = statSync(path, { bigint: true });
              else {
                priorDb.close();
                if (priorMemoryDirectory)
                  rmSync(priorMemoryDirectory, {
                    recursive: true,
                    force: true,
                  });
              }
            } catch (error) {
              candidate?.close();
              candidate = undefined;
              try {
                if (liveClosed && memory) {
                  db.close();
                  db = priorDb;
                  memoryDirectory = priorMemoryDirectory;
                  swapped = false;
                }
                if (liveClosed && !memory) {
                  if (swapped) {
                    try {
                      db.close();
                    } catch {
                      /* The replacement may not have opened. */
                    }
                    if (previous) {
                      renameSync(previousPath, path);
                      syncDirectory();
                    }
                  }
                  db = connect(path, false);
                  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
                  identity = statSync(path, { bigint: true });
                }
              } catch (recoveryError) {
                releaseFence = false;
                closed = true;
                throw new AggregateError(
                  [error, recoveryError],
                  "Restore and rollback failed; store remains fenced",
                  { cause: recoveryError },
                );
              }
              throw error;
            } finally {
              restoring = false;
              ownsFence = false;
              candidate?.close();
              if (lock !== undefined) {
                closeSync(lock);
                if (releaseFence) rmSync(fencePath);
              }
              // In-memory handles keep the staged database open until handle.close().
              if (!memory || !swapped) rmSync(candidatePath, { force: true });
              if (memory && !swapped)
                rmSync(directory, { recursive: true, force: true });
            }
          },
          exec(sql) {
            assertOpen();
            db.exec(sql);
          },
          run(sql, params = []) {
            assertOpen();
            const statement = prepare(sql);
            try {
              const result = statement.run(...params);
              return {
                changes: Number(result.changes),
                lastInsertRowid: result.lastInsertRowid,
              };
            } finally {
              statement.finalize?.();
            }
          },
          get(sql, params = []) {
            assertOpen();
            const statement = prepare(sql);
            try {
              return (statement.get(...params) ?? undefined) as
                SqlRow | undefined;
            } finally {
              statement.finalize?.();
            }
          },
          all(sql, params = []) {
            assertOpen();
            const statement = prepare(sql);
            try {
              return statement.all(...params) as SqlRow[];
            } finally {
              statement.finalize?.();
            }
          },
          transaction(body) {
            assertOpen();
            if (active) throw new Error("Nested transactions are refused");
            db.exec("BEGIN IMMEDIATE");
            active = true;
            try {
              assertOpen();
              const result = body();
              if (
                result !== null &&
                (typeof result === "object" || typeof result === "function") &&
                "then" in result
              )
                throw new Error("Transaction body must be synchronous");
              db.exec("COMMIT");
              return result;
            } catch (error) {
              try {
                db.exec("ROLLBACK");
              } catch (rollback) {
                throw new AggregateError(
                  [error, rollback],
                  "Transaction and rollback failed",
                  { cause: rollback },
                );
              }
              throw error;
            } finally {
              active = false;
            }
          },
        };
        return {
          ok: true,
          handle: {
            ownership: "owned",
            value,
            close() {
              if (!closed) {
                db.close();
                closed = true;
                if (memoryDirectory)
                  rmSync(memoryDirectory, { recursive: true, force: true });
              }
              return Promise.resolve();
            },
          },
        };
      } catch (error) {
        if (pinned !== undefined) closeSync(pinned);
        binding?.close();
        return {
          ok: false,
          unavailable: {
            kind: "unavailable",
            reason: String(error),
            remedy: "Use a supported runtime and a readable local store path",
          },
        };
      }
    },
  };
}

/** Both runtime and OS access stay at this boundary. */
export const sqliteStore: StorePort = {
  open(options) {
    return createSqliteStore(process.cwd()).open(options);
  },
};
