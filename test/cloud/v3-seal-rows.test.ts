import { expect, test } from "bun:test";
import { guardFixture, noWrites } from "./v3-project.fixture.ts";

const timeout = 30_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const firstPage = { page: 0, id: "directory:0", body: "[]", manifest: {} };
const refused = {
  status: 503,
  body: { ok: false, error: { code: "UNAVAILABLE" } },
};

type Fixture = ReturnType<typeof guardFixture>;

function watch(f: Fixture) {
  const statements: string[] = [];
  const original = f.storage.sql.exec.bind(f.storage.sql);
  f.storage.sql.exec = (statement, ...bindings) => {
    statements.push(statement);
    return original(statement, ...bindings);
  };
  return statements;
}

const namesMac = (statements: readonly string[]) =>
  statements.filter(
    (text) => /\bmac\b/.test(text) && !/pragma_table_info/.test(text),
  );

for (const populated of [false, true])
  test(
    `v3 restore into an old two-column commit table ${populated ? "with" : "without"} rows and no root is unavailable and changes nothing`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      f.db.run(
        "CREATE TABLE cloud_v3_commits (sequence INTEGER PRIMARY KEY CHECK(sequence>0), body TEXT NOT NULL)",
      );
      if (populated) f.db.run("INSERT INTO cloud_v3_commits VALUES (1, '{}')");
      const statements = watch(f);
      const effects = f.observeEffects();
      expect(await f.send("restore", firstPage)).toMatchObject(refused);
      expect(effects()).toEqual(noWrites);
      expect(namesMac(statements)).toEqual([]);
    },
    timeout,
  );
