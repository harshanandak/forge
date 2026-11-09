// Makes a new admin token inside this process and stores it two ways: as the Worker secret ADMIN_TOKEN
// (piped to `wrangler secret put` over stdin) and in ~/.agent-secrets/forge-cloud-dev.token for this
// user only. The token is never printed, logged or put on a command line. Run it from cloud/ with
// CLOUDFLARE_ACCOUNT_ID set. It is the first-time setup and the rotation: the old token stops working.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

const file = join(homedir(), ".agent-secrets", "forge-cloud-dev.token");
const token = randomBytes(32).toString("base64url");

const put = spawnSync(
  "wrangler",
  ["secret", "put", "ADMIN_TOKEN", "--name", "forge-cloud-dev"],
  { input: token, encoding: "utf8", shell: process.platform === "win32" },
);
if (put.status !== 0) {
  const error = `${put.stderr ?? ""}${put.stdout ?? ""}`
    .split(token)
    .join("[token]");
  console.error(`wrangler secret put failed: ${error.slice(-500)}`);
  process.exit(1);
}

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${token}\n`, { mode: 0o600 });
if (process.platform === "win32")
  spawnSync("icacls", [
    file,
    "/inheritance:r",
    "/grant:r",
    `${userInfo().username}:F`,
  ]);
else chmodSync(file, 0o600);
console.log(`ADMIN_TOKEN is set on forge-cloud-dev and saved to ${file}`);
