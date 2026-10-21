import {
  realpathSync,
  lstatSync,
  readFileSync,
  readSync,
  openSync,
  closeSync,
  fsyncSync,
  existsSync,
  statSync,
  fstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { inspectRecoveryFile } from "./recovery.ts";
import { probeFilesystem, type FilesystemProbe } from "./filesystem.ts";
import {
  adoptPrivateFile,
  copyPrivateFile,
  createPrivateFile,
  makePrivateTempDirectory,
  openStoreFile,
  removeDurable,
  renameDurable,
  writePrivateFile,
  securedFileOps,
  type DirectorySyncPort,
} from "./file-ops.ts";
import type { StateImageStore } from "../../core/state/index.ts";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  StorePort,
  SqlDatabase,
  SqlValue,
  SqlRow,
} from "../../ports/store.ts";
import { assertFilesystem } from "../../core/state/fs-class.ts";
import type { PrivateFileGuard } from "./private-files.ts";

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

export class StoreRestoringError extends Error {
  readonly code = "restoring";
  constructor(message = "Store is fenced for restore", options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreRestoringError";
  }
}

export function sqliteIdentityError(
  error: unknown,
  identityChanged = false,
): unknown {
  if (typeof error !== "object" || error === null) return error;
  // Node exposes errcode; Bun exposes errno/code. Some exec errors retain only
  // the generic message, which needs independent file-identity evidence.
  const vnode =
    ("errcode" in error && error.errcode === 6922) ||
    ("errno" in error && error.errno === 6922) ||
    ("code" in error && error.code === "SQLITE_IOERR_VNODE");
  if (
    vnode ||
    (identityChanged &&
      "message" in error &&
      error.message === "disk I/O error")
  )
    return new StoreRestoringError(
      "Store identity changed (SQLite VNODE); operation refused; reopen required",
      { cause: error },
    );
  return error;
}

function assertSingleLink(
  path: string,
  file:
    | {
        readonly nlink: bigint;
        isFile(): boolean;
        isDirectory(): boolean;
      }
    | undefined,
): void {
  if (file && !file.isFile())
    throw new Error(
      `${path} is ${file.isDirectory() ? "a directory" : "not a regular file"}, expected the Forge store file; move or delete it`,
    );
  // Path-scoped fences cannot exclude hard-link aliases (including NTFS).
  // Refuse them instead of maintaining a second identity-scoped lock protocol.
  if (file && file.nlink > 1n)
    throw new StoreRestoringError(
      "Hard-linked store files are refused; remove extra links before opening or restoring",
    );
}

function changeMarker(path: string): number {
  const fd = openSync(path, "r");
  try {
    const counter = Buffer.alloc(4);
    if (readSync(fd, counter, 0, 4, 24) !== 4)
      throw new Error("Store change counter is unreadable");
    return counter.readUInt32BE();
  } finally {
    closeSync(fd);
  }
}

/** Hosts may bind relative store paths to an explicit absolute base directory. */
export interface RestoreHooks {
  readonly security?: PrivateFileGuard;
  readonly filesystem?: FilesystemProbe;
  readonly step?: (step: string) => void;
  readonly fs?: DirectorySyncPort & {
    renameSync(from: string, to: string): void;
  };
}

export function createSqliteStore(
  basePath: string,
  hooks: RestoreHooks = {},
): StorePort {
  if (!isAbsolute(basePath)) throw new Error("Store base must be absolute");
  if (hooks.security)
    hooks = { ...hooks, fs: securedFileOps(hooks.security, hooks.fs) };
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
            ...(path === ":memory:"
              ? {}
              : probeFilesystem(dirname(path), hooks.filesystem)),
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
            throw new StoreRestoringError();
        };
        assertUnfenced();
        const expectedIdentity =
          path === ":memory:" || !existsSync(path)
            ? undefined
            : statSync(path, { bigint: true });
        assertSingleLink(path, expectedIdentity);
        hooks.step?.("identity-checked");
        // Keep the opened inode pinned across SQLite's open; reject either side
        // of a pathname replacement rather than adopting its newer identity.
        if (path !== ":memory:")
          pinned = openStoreFile(path, options.readOnly, hooks.fs);
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
        assertSingleLink(path, identity);
        assertSingleLink(path, current);
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
            throw new StoreRestoringError();
          if (identity) {
            const current = statSync(path, { bigint: true });
            assertSingleLink(path, current);
            if (identity.dev !== current.dev || identity.ino !== current.ino)
              throw new Error("Store identity changed; reopen required");
          }
        };
        const storeError = (error: unknown): unknown => {
          let changed = false;
          if (identity) {
            try {
              const current = statSync(path, { bigint: true });
              changed =
                current.nlink > 1n ||
                current.dev !== identity.dev ||
                current.ino !== identity.ino;
            } catch {
              // A failed probe must not hide the original SQLite error.
            }
          }
          return sqliteIdentityError(error, changed);
        };
        const storeCall = <T>(body: () => T): T => {
          try {
            return body();
          } catch (error) {
            throw storeError(error);
          }
        };
        const transact = <T>(body: () => T): T => {
          assertOpen();
          if (active) throw new Error("Nested transactions are refused");
          hooks.step?.("write-pre-lock");
          hooks.step?.("write-lock-attempt");
          db.exec("BEGIN IMMEDIATE");
          active = true;
          try {
            hooks.step?.("write-locked");
            assertOpen();
            const result = body();
            if (
              result !== null &&
              (typeof result === "object" || typeof result === "function") &&
              "then" in result
            )
              throw new Error("Transaction body must be synchronous");
            assertOpen();
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
        };
        const execute = <T>(body: () => T): T =>
          storeCall(() => {
            assertOpen();
            if (active || options.readOnly) return body();
            return transact(body);
          });
        const value: StateImageStore = {
          exportImage(inspect) {
            assertOpen();
            if (active) throw new Error("Cannot export during a transaction");
            const directory = makePrivateTempDirectory(
              join(tmpdir(), ".forge-export-"),
              hooks.fs,
            );
            const destination = join(directory, "snapshot.db");
            try {
              // SQLite creates a consistent complete image, including WAL contents, without INSERT replay.
              db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
              adoptPrivateFile(destination, hooks.fs);
              const captured = connect(destination, true);
              try {
                inspect?.(wrap(captured));
              } finally {
                captured.close();
              }
              return new Uint8Array(readFileSync(destination));
            } catch (error) {
              throw storeError(error);
            } finally {
              removeDurable(
                directory,
                { recursive: true, force: true },
                hooks.fs,
              );
            }
          },
          // Restore creates the file fence before taking SQLite's exclusive lock.
          // Every live SQL entry takes BEGIN IMMEDIATE and checks fence + identity
          // under that lock; nested calls reuse it, so queued writers roll back.
          // Final approval holds the exclusive lock and permits reads only.
          // Closing SQLite releases its lock, but the file fence stays through swap.
          // Capture the file change counter at approval and recheck just before
          // rename: an out-of-band commit cancels restore, preserving that write.
          restoreImage(image, validate, prepareCandidate, verify) {
            assertOpen();
            if (options.readOnly || active)
              throw new Error("Restore requires an idle writable store");
            const memory = path === ":memory:";
            const directory = memory
              ? makePrivateTempDirectory(
                  join(tmpdir(), ".forge-restore-"),
                  hooks.fs,
                )
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
            let approvedMarker: number | undefined;
            const priorDb = db;
            const priorMemoryDirectory = memoryDirectory;
            const step = (name: string): void => {
              hooks.step?.(name);
            };
            try {
              writePrivateFile(candidatePath, image, hooks.fs);
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
                lock = createPrivateFile(fencePath, "wx", hooks.fs);
                ownsFence = true;
                fsyncSync(lock);
              }
              // A writer lock prevents other SQLite writers changing the target during final approval.
              db.exec("BEGIN EXCLUSIVE");
              try {
                active = true;
                db.exec("PRAGMA query_only=ON");
                verify();
                if (!memory) {
                  assertSingleLink(path, statSync(path, { bigint: true }));
                  approvedMarker = changeMarker(path);
                }
                step("fenced");
              } catch (error) {
                db.exec("ROLLBACK");
                throw error;
              } finally {
                active = false;
                db.exec("PRAGMA query_only=OFF");
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
                copyPrivateFile(path, previousPath, hooks.fs);
                previous = true;
                syncFile(previousPath);
                step("retained");
                const currentCandidate = inspectRecoveryFile(candidatePath);
                if (
                  JSON.stringify(currentCandidate) !==
                  JSON.stringify(approvedCandidate)
                )
                  throw new Error("Candidate identity drift before swap");
                const current = statSync(path, { bigint: true });
                assertSingleLink(path, current);
                if (
                  current.dev !== identity?.dev ||
                  current.ino !== identity.ino ||
                  changeMarker(path) !== approvedMarker
                )
                  throw new Error(
                    "Store changed after final approval; restore refused",
                  );
                renameDurable(candidatePath, path, hooks.fs);
                swapped = true;
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
                  removeDurable(
                    priorMemoryDirectory,
                    {
                      recursive: true,
                      force: true,
                    },
                    hooks.fs,
                  );
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
                      renameDurable(previousPath, path, hooks.fs);
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
              throw storeError(error);
            } finally {
              restoring = false;
              ownsFence = false;
              candidate?.close();
              if (lock !== undefined) {
                closeSync(lock);
                if (releaseFence) removeDurable(fencePath, undefined, hooks.fs);
              }
              // In-memory handles keep the staged database open until handle.close().
              if (!memory || !swapped)
                removeDurable(candidatePath, { force: true }, hooks.fs);
              if (memory && !swapped)
                removeDurable(
                  directory,
                  { recursive: true, force: true },
                  hooks.fs,
                );
            }
          },
          exec(sql) {
            execute(() => db.exec(sql));
          },
          run(sql, params = []) {
            return execute(() => {
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
            });
          },
          get(sql, params = []) {
            return execute(() => {
              const statement = prepare(sql);
              try {
                return (statement.get(...params) ?? undefined) as
                  SqlRow | undefined;
              } finally {
                statement.finalize?.();
              }
            });
          },
          all(sql, params = []) {
            return execute(() => {
              const statement = prepare(sql);
              try {
                return statement.all(...params) as SqlRow[];
              } finally {
                statement.finalize?.();
              }
            });
          },
          transaction(body) {
            return storeCall(() => transact(body));
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
                  removeDurable(
                    memoryDirectory,
                    { recursive: true, force: true },
                    hooks.fs,
                  );
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
