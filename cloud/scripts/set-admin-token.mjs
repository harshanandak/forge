// Makes a new admin token inside this process and stores it two ways: as the Worker secret ADMIN_TOKEN
// (piped to the locally installed wrangler over stdin) and in ~/.forge-cloud/forge-cloud-dev.token for
// this user only. The token is never printed, logged or put on a command line. Run it from cloud/ with
// --config <your local wrangler config>, which names the Worker and account. It is the first-time setup and the rotation: the old token stops working.
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

const target = join(homedir(), ".forge-cloud", "forge-cloud-dev.token");
const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const token = randomBytes(32).toString("base64url");
const config = process.argv[process.argv.indexOf("--config") + 1];

// Blanks and deletes the temp file, if there is one. Blanking and deleting are separate steps, so a
// failed blank never skips the delete; a failed delete names the leftover path (never its content).
function discard() {
  if (!existsSync(temp)) return;
  try {
    writeFileSync(temp, "");
  } catch {
    /* the delete below still runs */
  }
  try {
    unlinkSync(temp);
  } catch {
    console.error(`Could not delete the temp file ${temp}. Delete it by hand.`);
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

const folder = dirname(target);
const me = userInfo().username;

// The only principals allowed on the token folder and the token file on Windows: this user, SYSTEM and
// Administrators. The last two can already read everything, so they are outside the threat model.
// The folder check and the file check share this list and aclProblem, so they cannot drift apart.
const yours = [
  `${process.env.USERDOMAIN}\\${me}`,
  `${process.env.COMPUTERNAME}\\${me}`,
].map((name) => name.toLowerCase());
const allowed = [...yours, "nt authority\\system", "builtin\\administrators"];

// Why a Windows path is open to someone besides this user, or undefined when it is not. Fails closed:
// an unreadable ACL, an unknown principal and any DENY entry are all refused. With requireFull, this
// user must also hold full control (F).
function aclProblem(path, requireFull) {
  const shown = spawnSync("icacls", [path], { encoding: "utf8" });
  if (shown.status !== 0) return "has permissions that could not be read";
  const entries = `${shown.stdout}`
    .split(/\r?\n/)
    .filter((line) => line.includes(":("));
  if (entries.length === 0)
    return "has no permission entries that could be read";
  let full = false;
  for (const line of entries) {
    const cut = line.indexOf(":(");
    const who = line.slice(0, cut).trimEnd().toLowerCase();
    const name = allowed.find((n) => who === n || who.endsWith(` ${n}`));
    if (name === undefined) return "is open to someone besides you";
    const rights = line.slice(cut).toLowerCase();
    if (rights.includes("(deny)")) return "has a deny entry";
    if (yours.includes(name) && rights.includes("(f)")) full = true;
  }
  return requireFull && !full ? "does not give you full control" : undefined;
}

// Why the token folder is not private to this user, or undefined when it is. It is checked before any
// file is created in it: a handle opened on a file while the folder was open to others would outlive a
// later permission change.
function folderProblem() {
  if (process.platform === "win32") return aclProblem(folder, false);
  const info = statSync(folder);
  return (info.mode & 0o077) !== 0 || info.uid !== process.getuid()
    ? "is open to someone besides you"
    : undefined;
}
const fix =
  process.platform === "win32"
    ? `icacls "${folder}" /inheritance:r /grant:r "${me}:(OI)(CI)F"`
    : `chmod 700 "${folder}"`;

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
    const problem = aclProblem(temp, true);
    if (problem !== undefined) throw new Error(`the file ${problem}`);
  } else {
    const info = statSync(temp);
    if ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid())
      throw new Error("the file is not owner-only");
  }
}

if (process.argv.indexOf("--config") < 1 || !config || !existsSync(config))
  stop(
    "Pass --config <your local wrangler config>; see docs/reference/cloud.md.",
  );
if (!existsSync(wrangler))
  stop("Run `bun install` in cloud/ first: wrangler is not installed.");
try {
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true, mode: 0o700 });
} catch (error) {
  stop(`Could not create ${folder}: ${error.message}`);
}
const problem = folderProblem();
if (problem !== undefined)
  stop(
    `Refusing to write: ${folder} ${problem}. Fix it yourself, then run this again: ${fix}`,
  );
try {
  writeFileSync(temp, "", { flag: "wx", mode: 0o600 });
  restrict();
} catch (error) {
  stop(`Could not prepare a private token file: ${error.message}`);
}

const put = spawnSync(
  process.execPath,
  [wrangler, "secret", "put", "ADMIN_TOKEN", "--config", config],
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
console.log(`ADMIN_TOKEN is set and saved to ${target}`);
