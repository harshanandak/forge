// Makes a new admin token inside this process and stores it two ways: as the Worker secret ADMIN_TOKEN
// (piped to the locally installed wrangler over stdin) and in ~/.agent-secrets/forge-cloud-dev.token for
// this user only. The token is never printed, logged or put on a command line. Run it from cloud/ with
// CLOUDFLARE_ACCOUNT_ID set. It is the first-time setup and the rotation: the old token stops working.
//
// Order, so nothing fails open:
//   1. Make an empty temp file beside the target and prove only this user can read it.
//   2. Set the live secret.
//   3. Write the token into the temp file and rename it over the target, so an old file's grants cannot survive.
// Any failure exits non-zero with no success message and leaves no token-bearing file behind.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const target = join(homedir(), ".agent-secrets", "forge-cloud-dev.token");
const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const token = randomBytes(32).toString("base64url");

function discard() {
  try {
    writeFileSync(temp, "");
    unlinkSync(temp);
  } catch {
    /* nothing was written or it is already gone */
  }
}
function stop(message, liveChanged = false) {
  discard();
  console.error(message);
  if (liveChanged)
    console.error(
      "The live ADMIN_TOKEN was CHANGED and the local copy was not saved. Run this script again to rotate.",
    );
  process.exit(1);
}

// Proves the temp file can be read by this user only. Throws if not.
function restrict() {
  if (process.platform === "win32") {
    const user = userInfo().username;
    const set = spawnSync(
      "icacls",
      [temp, "/inheritance:r", "/grant:r", `${user}:F`],
      {
        encoding: "utf8",
      },
    );
    if (set.status !== 0) throw new Error("icacls could not restrict the file");
    const shown = spawnSync("icacls", [temp], { encoding: "utf8" });
    const grants = [...`${shown.stdout}`.matchAll(/(\S+):\(/g)].map(
      (m) => m[1],
    );
    const only =
      grants.length === 1 &&
      grants[0].split("\\").pop().toLowerCase() === user.toLowerCase();
    if (shown.status !== 0 || !only || !`${shown.stdout}`.includes(":(F)"))
      throw new Error("the file is readable by someone besides this user");
  } else {
    const info = statSync(temp);
    if ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid())
      throw new Error("the file is not owner-only");
  }
}

if (!existsSync(wrangler))
  stop("Run `bun install` in cloud/ first: wrangler is not installed.");
try {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(temp, "", { flag: "wx", mode: 0o600 });
  restrict();
} catch (error) {
  stop(`Could not prepare a private token file: ${error.message}`);
}

const put = spawnSync(
  process.execPath,
  [wrangler, "secret", "put", "ADMIN_TOKEN", "--name", "forge-cloud-dev"],
  { input: token, encoding: "utf8" },
);
if (put.status !== 0)
  stop(
    `wrangler secret put failed: ${`${put.stderr}${put.stdout}`.split(token).join("[token]").slice(-500)}`,
  );

try {
  writeFileSync(temp, `${token}\n`);
  renameSync(temp, target);
} catch (error) {
  stop(`Could not save the token file: ${error.message}`, true);
}
console.log(`ADMIN_TOKEN is set on forge-cloud-dev and saved to ${target}`);
