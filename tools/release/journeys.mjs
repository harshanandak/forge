import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runWithin } from "../pack-smoke/bounded.ts";
import {
  environmentWithoutBun,
  resolveBun,
} from "../pack-smoke/environment.ts";

const [cwd, consumer, tarball] = process.argv.slice(2);
assert.ok(cwd && consumer && tarball);
const dir = mkdtempSync(join(tmpdir(), "forge-release-report-"));
try {
  const report = join(dir, "junit.xml");
  await runWithin(
    "registry installed journeys",
    resolveBun(),
    [
      "test",
      "--parallel=2",
      "--timeout",
      "30000",
      "packed.integration.test",
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    {
      cwd,
      env: {
        ...environmentWithoutBun(process.execPath),
        FORGE_PACKED_CONSUMER: consumer,
        FORGE_PACKED_TARBALL: tarball,
        FORGE_AUTHOR_NPM_ROOT: dirname(process.execPath),
        FORGE_RELEASE_ACCEPTANCE: "1",
      },
    },
    480_000,
  );
  const xml = readFileSync(report, "utf8");
  assert.match(xml, /<testcase\b/, "release requires executed journeys");
  assert.doesNotMatch(
    xml,
    /<skipped\b|skipped=["'][1-9]/,
    "release journey skipped",
  );
  assert.doesNotMatch(xml, /<(?:failure|error)\b/, "release journey failed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
