// `forge auth login`: the device flow against one Forge cloud project, then a private credential.
//
// The CLI starts a challenge, prints the verification address and the user code on stderr, and polls
// until the owner approves it in a browser. Nothing is held while waiting: the credential file is
// locked only to merge one verified entry, and the project binding is written last, after the
// credential has read back. Nothing here sends a bearer token, and nothing routes any other command
// to the cloud. The forge/cloud block declares the operation; this is the service it calls.
import { nodeDeviceIdentity } from "../adapters/fs/device-identity.ts";
import {
  createCloudHttp,
  validateOrigin,
  validateProject,
  type CloudFetch,
  type LoginChallenge,
} from "../adapters/http/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { validateWithSchema } from "../contract/schema.ts";
import type { DesktopLauncher } from "../ports/process.ts";
import type { CloudLogin, CloudLoginResult } from "../ports/cloud-login.ts";
import {
  credentialStore,
  openCloudFiles,
  parseDeviceCredential,
  readBinding,
  resolveTarget,
  writeBinding,
} from "./cloud-profile.ts";
import { readProjectManifest } from "./project-manifest.ts";
import { wireDeviceId } from "./wire-device.ts";

export { wireDeviceId };

export const CLOUD_LOGIN_OP = "cloud.login";

export interface CloudLoginDeps {
  /** The checkout root that holds .forge/project.json. */
  readonly root: string;
  /** The home folder whose .forge/cloud holds the credential file. */
  readonly home: string | undefined;
  /** Where the persistent device id lives. */
  readonly deviceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: CloudFetch;
  readonly browser?: DesktopLauncher;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  /** Sleep that rejects when the signal aborts. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Ends the wait: the invocation's own cancellation and deadline. */
  readonly signal: AbortSignal;
  /** Progress lines; the default writes to stderr. */
  readonly progress?: (line: string) => void;
  /** Private-file checks for the credential folder; the host default is used when left out. */
  readonly security?: {
    directory(path: string, created?: boolean): void;
    file(path: string): void;
  };
}

/** What the operation accepts. The block's own schema is loose on purpose: the shared validator quotes a rejected value, and this input can hold a token pasted into the wrong place. */
const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    origin: { type: "string", minLength: 1, maxLength: 300 },
    project: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

const failed = (message: string, code: string): ForgeFailure =>
  new ForgeFailure({ code, message, retry: "never" });
const cancelled = (): ForgeFailure =>
  failed("The login was cancelled.", "INVOCATION_CANCELLED");

/** The server's refusal as one of our fixed messages; the name is from a closed vocabulary. */
function refusalFailure(name: string): ForgeFailure {
  if (name === "access_denied")
    return failed("The owner denied this login.", "LOGIN_DENIED");
  if (name === "expired_token")
    return failed(
      "The login code expired; run forge auth login again.",
      "LOGIN_EXPIRED",
    );
  return failed(
    `The Forge cloud refused the login (${name}).`,
    "LOGIN_REFUSED",
  );
}

function deviceId(deps: CloudLoginDeps): string {
  const override = deps.env.FORGE_DEVICE_ID?.trim() || undefined;
  try {
    if (override !== undefined) {
      if (override.length > 256 || /[\s/\\]/.test(override))
        throw new Error("invalid");
      return override;
    }
    return nodeDeviceIdentity(deps.deviceRoot).acquire();
  } catch {
    throw new ForgeFailure({
      code: "CONTEXT_MISSING",
      message:
        "A device identity is unavailable; set FORGE_DEVICE_ID to a readable id without spaces or slashes.",
      missing: ["device"],
      retry: "never",
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollForCredential(
  deps: CloudLoginDeps,
  http: ReturnType<typeof createCloudHttp>,
  challenge: LoginChallenge,
  signal: AbortSignal,
  deadline: number,
): Promise<string> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? sleep;
  // The deadline is fixed when the challenge starts; a server that keeps saying pending cannot move it.
  let interval = challenge.interval;
  for (;;) {
    // No wait, however long the server asks, runs past the challenge's own lifetime.
    const remaining = deadline - now();
    if (remaining <= 0) throw refusalFailure("expired_token");
    try {
      await wait(Math.min(interval * 1_000, remaining), signal);
    } catch {
      throw cancelled();
    }
    const left = deadline - now();
    if (left <= 0) throw refusalFailure("expired_token");
    // The request and its body end at the deadline too, so a poll started just before it cannot be
    // accepted after it. A transport failure ends the login: the poll may have consumed the challenge,
    // so it is neither retried nor restarted.
    const expiry = AbortSignal.timeout(left);
    let result: Awaited<ReturnType<typeof http.loginPoll>>;
    try {
      result = await http.loginPoll(
        challenge.deviceCode,
        AbortSignal.any([signal, expiry]),
      );
    } catch (error) {
      if (expiry.aborted && !signal.aborted)
        throw refusalFailure("expired_token");
      throw error;
    }
    if (result.kind === "credential") {
      if (now() >= deadline) throw refusalFailure("expired_token");
      return result.credential;
    }
    if (result.error === "authorization_pending") continue;
    if (result.error === "slow_down") {
      interval = Math.min(300, Math.max(result.interval ?? 0, interval + 5));
      continue;
    }
    throw refusalFailure(result.error);
  }
}

/** Browser launch is best effort; the printed link remains usable on every host. */
async function openBrowser(deps: CloudLoginDeps, url: string): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (
    !deps.browser ||
    deps.env.FORGE_NO_BROWSER === "1" ||
    (platform === "linux" && !deps.env.DISPLAY && !deps.env.WAYLAND_DISPLAY)
  )
    return;
  const command =
    platform === "win32"
      ? ["rundll32.exe", "url.dll,FileProtocolHandler"]
      : platform === "darwin"
        ? ["open"]
        : platform === "linux"
          ? ["xdg-open"]
          : [];
  if (!command.length) return;
  try {
    const env = Object.fromEntries(
      Object.entries(deps.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const executable = deps.browser.resolve(command[0]!, env);
    if (executable.kind !== "resolved") return;
    await deps.browser.launch(executable, [...command.slice(1), url], {
      cwd: deps.root,
      env,
      signal: deps.signal,
    });
  } catch {
    // Missing desktops and failed openers do not stop the device flow.
  }
}

async function login(
  deps: CloudLoginDeps,
  input: unknown,
): Promise<CloudLoginResult> {
  const problems = validateWithSchema(INPUT_SCHEMA, input);
  // One fixed refusal, with no field name, pointer or value: a credential pasted into the input, as a
  // value or as a property name, must never come back in an error.
  if (problems.length > 0)
    throw new ForgeFailure({
      code: "INPUT_INVALID",
      message: `Invalid input for ${CLOUD_LOGIN_OP}: expected {"origin": "<https origin>", "project": "<project name>"}, both optional`,
      retry: "never",
    });
  const given = input as { origin?: string; project?: string };
  const asked = {
    ...(given.origin === undefined
      ? {}
      : { origin: validateOrigin(given.origin) }),
    ...(given.project === undefined
      ? {}
      : { project: validateProject(given.project) }),
  };

  const manifest = readProjectManifest(deps.root);
  if (manifest === undefined)
    throw new ForgeFailure({
      code: "CONTEXT_MISSING",
      message:
        "This checkout has no project identity (.forge/project.json); auth login never creates one.",
      missing: ["project"],
      retry: "never",
      repair: "Run forge project init, commit the file, then log in.",
    });
  const files = openCloudFiles(deps.home, deps.security);
  const store = credentialStore(files);
  const target = resolveTarget(
    asked,
    manifest.id,
    readBinding(deps.root),
    store.associations(manifest.id),
  );
  const local = deviceId(deps);
  const wire = wireDeviceId(local);
  const signal = deps.signal;

  const http = createCloudHttp({
    origin: target.origin,
    project: target.project,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  const started = await http.loginStart(wire, signal);
  if (started.kind === "refused") throw refusalFailure(started.error);
  const { challenge } = started;
  const deadline = (deps.now ?? Date.now)() + challenge.expiresIn * 1_000;
  const progress =
    deps.progress ??
    ((line: string) =>
      process.stderr.write(`${line}
`));
  const link = `${target.origin}/device?code=${encodeURIComponent(challenge.userCode)}`;
  progress(`Open ${link}`);
  progress(`Code: ${challenge.userCode}`);
  progress(
    `Waiting for the owner to approve; the code expires in ${challenge.expiresIn} seconds.`,
  );
  await openBrowser(deps, link);
  const text = await pollForCredential(deps, http, challenge, signal, deadline);
  const credential = parseDeviceCredential(
    text,
    wire,
    (deps.now ?? Date.now)(),
  );
  await store.save({
    origin: target.origin,
    identity: manifest.id,
    project: target.project,
    localDevice: local,
    ...credential,
  });
  let binding: "created" | "unchanged";
  try {
    binding = writeBinding(deps.root, {
      schema: 1,
      identity: manifest.id,
      origin: target.origin,
      project: target.project,
    });
  } catch (error) {
    throw new ForgeFailure({
      ...(error instanceof ForgeFailure
        ? error.error
        : {
            code: "UNAVAILABLE",
            message: "The project binding could not be written.",
            retry: "never" as const,
          }),
      repair:
        "The credential was saved. Run forge auth login again to finish the binding.",
    });
  }
  return {
    origin: target.origin,
    project: target.project,
    device: wire,
    tokenId: credential.id,
    expiresAt: credential.expiresAt,
    binding,
  };
}

/** The login service one invocation gets. */
export function createCloudLogin(deps: CloudLoginDeps): CloudLogin {
  return { login: (input) => login(deps, input) };
}
