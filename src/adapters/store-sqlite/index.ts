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

/** Both bindings stay at this boundary; consumers only see StorePort. */
export const sqliteStore: StorePort = {
  async open(options) {
    let binding: Binding | undefined;
    try {
      assertFilesystem(
        {
          path: options.path,
          platform: process.platform,
          cloudRoots: [
            process.env.OneDrive,
            process.env.OneDriveConsumer,
            process.env.OneDriveCommercial,
            process.env.Dropbox,
          ].filter((value): value is string => Boolean(value)),
        },
        (message) => {
          process.stderr.write(message);
        },
      );
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
        binding = new runtime.Database(options.path, {
          readonly: options.readOnly,
          create: !options.readOnly,
          safeIntegers: true,
        });
      } else {
        const { DatabaseSync } = await import("node:sqlite");
        binding = new DatabaseSync(options.path, {
          readOnly: options.readOnly,
        });
      }
      const db = binding;
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
      };
      const value: SqlDatabase = {
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
            }
            return Promise.resolve();
          },
        },
      };
    } catch (error) {
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
