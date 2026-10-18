import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "forge-unknown-fs-")));
try {
  const store = createSqliteStore(work, {
    filesystem: {
      platform: "linux",
      statfs: () => ({ type: 0xdeadbeef }),
      realpath: (path) => path,
    },
  });
  for (let i = 0; i < 2; i++) {
    const opened = await store.open({
      path: join(work, "state.db"),
      readOnly: false,
    });
    assert.equal(opened.ok, true);
    await opened.handle.close();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
