import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const dbModule = new URL("../../dist/core/db.js", import.meta.url).href;
const dbReasons = new Set([
  "Cannot create a private hub database file",
  "Hub database parent chain is unsafe",
  "Hub database directory is not private",
  "Hub database file is not private",
  "Hub database file identity is unavailable",
  "Hub database file identity changed",
  "Hub database changed during schema inspection",
  "Hub database requires WAL mode",
]);

function errorCode(error) {
  return /^[A-Z][A-Z0-9_]+$/.test(error?.code) ? error.code : "-";
}

function diagnose(operation, run) {
  try {
    return run();
  } catch (error) {
    const code = errorCode(error);
    const reason = dbReasons.has(error?.message) ? error.message : "";
    const sqlite = Number.isInteger(error?.errcode) ? error.errcode : "-";
    const frame = /\/core\/(db|schema-probe|schema)\.js:(\d+):\d+/.exec(
      error?.stack ?? "",
    );
    const site = frame ? ` at ${frame[1]}.js:${frame[2]}` : "";
    process.stderr.write(
      `hub database ${operation} failed (${code}, SQLite ${sqlite})${site} ${reason}\n`,
    );
    throw error;
  }
}

export function traceDatabase(open) {
  return (path) => {
    const db = diagnose("open", () => open(path));
    return { ...db, close: () => diagnose("close", () => db.close()) };
  };
}

const originalDb = JSON.stringify(dbModule + "?diagnostic-original");
registerHooks({
  load(url, context, nextLoad) {
    if (url !== dbModule) return nextLoad(url, context);
    return {
      shortCircuit: true,
      format: "module",
      source: `
        export * from ${originalDb};
        import { openHubDb as open } from ${originalDb};
        import { traceDatabase } from ${JSON.stringify(import.meta.url)};
        export const openHubDb = traceDatabase(open);
      `,
    };
  },
});

const spawn = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  const started = Date.now();
  const result = spawn(...args);
  const [command, , options] = args;
  if (
    !/[\\/]powershell\.exe$/i.test(command) ||
    options?.encoding !== "utf8" ||
    typeof options?.input !== "string" ||
    (result.status === 0 &&
      !result.error &&
      result.stderr === "" &&
      result.stdout?.trim() === "private")
  )
    return result;
  let details = "";
  try {
    const { operation, kind, path } = JSON.parse(
      Buffer.from(options.input, "base64").toString("utf8"),
    );
    if (/^(verify(-chain)?|create-(dir|file)|harden-file)$/.test(operation)) {
      const name = basename(path);
      const target = /^hub\.sqlite(?:-(?:wal|shm|journal))?$/.test(name)
        ? name
        : kind === "dir"
          ? "directory"
          : "file";
      details = ` ${operation} ${target}`;
    }
  } catch {
    details = " (unreadable request)";
  }
  const marker = /^chain_[a-z_]+:\d+$/.exec(result.stderr?.trim() ?? "")?.[0];
  process.stderr.write(
    `hub ACL${details} failed (${errorCode(result.error)}, exit ${result.status}, ${Date.now() - started} ms, budget ${options.timeout} ms)${marker ? " " + marker : ""}\n`,
  );
  return result;
};
syncBuiltinESMExports();
