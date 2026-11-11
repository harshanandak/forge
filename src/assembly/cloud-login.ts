// `forge cloud login`: the device flow against one Forge cloud project, then a private credential.
//
// The CLI starts a challenge, prints the verification address and the user code on stderr, and polls
// until the owner approves it in a browser. Nothing is held while waiting: the credential file is
// locked only to merge one verified entry, and the project binding is written last, after the
// credential has read back. Nothing here sends a bearer token, and nothing routes any other command
// to the cloud.
import { createHash } from "node:crypto";
import { nodeDeviceIdentity } from "../adapters/fs/device-identity.ts";
import {
  createCloudHttp,
  validateOrigin,
  validateProject,
  type CloudFetch,
  type LoginChallenge,
} from "../adapters/http/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { inputError } from "../contract/input-error.ts";
import type { McpCandidate } from "../contract/mcp.ts";
import { validateWithSchema } from "../contract/schema.ts";
import type { InvocationRequest, ResultEnvelope } from "../generated/types.ts";
import type { SurfaceCatalog } from "../surface/catalog.ts";
import {
  credentialStore,
  openCloudFiles,
  parseDeviceCredential,
  readBinding,
  resolveTarget,
  writeBinding,
} from "./cloud-profile.ts";
import { readProjectManifest } from "./project-manifest.ts";

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
  readonly now?: () => number;
  /** Sleep that rejects when the signal aborts. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Progress lines; the default writes to stderr. */
  readonly progress?: (line: string) => void;
  /** Private-file checks for the credential folder; the host default is used when left out. */
  readonly security?: {
    directory(path: string, created?: boolean): void;
    file(path: string): void;
  };
}

const WIRE_DEVICE = /^[A-Za-z0-9][\w.:-]{0,127}$/;

/**
 * The device id sent to the Worker. An id the Worker accepts goes unchanged; any other becomes
 * `device-` plus the SHA-256 of the full local id. The local device-id file never changes, and
 * whatever compares holder identity later must apply this same mapping.
 */
export function wireDeviceId(local: string): string {
  return WIRE_DEVICE.test(local)
    ? local
    : `device-${createHash("sha256").update(local).digest("hex")}`;
}

export const cloudLoginCandidate: McpCandidate = {
  op: CLOUD_LOGIN_OP,
  admitted: true,
  declaration: {
    input: "cloud-login.input.json",
    output: "cloud-login.output.json",
    context: "device",
    effects: ["files:write", "external:forge-cloud"],
    destructive: false,
    idempotent: false,
    callers: ["human"],
    stability: "experimental",
  },
  docs: {
    title: "Log in to Forge cloud",
    summary:
      "Log this device in to one Forge cloud project. Prints a code and an address; the owner approves it in a browser.",
    description:
      "Starts a device login, waits for the owner to approve it, then saves this device's credential in a private file under ~/.forge/cloud and binds the project in .forge/cloud.json. The first login needs --origin and --project; later logins use the binding, which login never changes. The token is never printed.",
    examples: [
      {
        input: { origin: "https://forge.example.com", project: "my-project" },
      },
    ],
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      origin: { type: "string", minLength: 1, maxLength: 300 },
      project: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
  outputSchema: {
    type: "object",
    required: [
      "origin",
      "project",
      "device",
      "tokenId",
      "expiresAt",
      "binding",
    ],
    additionalProperties: false,
    properties: {
      origin: { type: "string" },
      project: { type: "string" },
      device: { type: "string" },
      tokenId: { type: "string" },
      expiresAt: { type: "string" },
      binding: { enum: ["created", "unchanged"] },
    },
  },
};

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
      "The login code expired; run forge cloud login again.",
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

/** Ctrl-C ends the wait instead of killing the process mid-write. */
function interrupt(): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const on = () => controller.abort();
  process.once("SIGINT", on);
  return {
    signal: controller.signal,
    dispose: () => process.off("SIGINT", on),
  };
}

async function pollForCredential(
  deps: CloudLoginDeps,
  http: ReturnType<typeof createCloudHttp>,
  challenge: LoginChallenge,
  signal: AbortSignal,
): Promise<string> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? sleep;
  // The deadline is fixed when the challenge starts; a server that keeps saying pending cannot move it.
  const deadline = now() + challenge.expiresIn * 1_000;
  let interval = challenge.interval;
  for (;;) {
    try {
      await wait(interval * 1_000, signal);
    } catch {
      throw cancelled();
    }
    if (now() >= deadline) throw refusalFailure("expired_token");
    // A transport failure here ends the login: the poll may have consumed the challenge, so it is
    // neither retried nor restarted.
    const result = await http.loginPoll(challenge.deviceCode, signal);
    if (result.kind === "credential") return result.credential;
    if (result.error === "authorization_pending") continue;
    if (result.error === "slow_down") {
      interval = Math.min(300, Math.max(result.interval ?? 0, interval + 5));
      continue;
    }
    throw refusalFailure(result.error);
  }
}

async function login(
  deps: CloudLoginDeps,
  request: InvocationRequest,
): Promise<Record<string, string>> {
  if (request.dryRun === true)
    throw failed(
      "cloud.login cannot be previewed; run it without --dry-run.",
      "INPUT_INVALID",
    );
  const problems = validateWithSchema(
    cloudLoginCandidate.inputSchema,
    request.input,
    true,
  );
  if (problems.length > 0)
    throw new ForgeFailure(
      inputError(
        CLOUD_LOGIN_OP,
        problems,
        cloudLoginCandidate.docs,
        cloudLoginCandidate.inputSchema,
      ),
    );
  const given = request.input as { origin?: string; project?: string };
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
        "This checkout has no project identity (.forge/project.json); cloud login never creates one.",
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

  const own = deps.signal === undefined ? interrupt() : undefined;
  const signal = deps.signal ?? own!.signal;
  try {
    const http = createCloudHttp({
      origin: target.origin,
      project: target.project,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
    const started = await http.loginStart(wire, signal);
    if (started.kind === "refused") throw refusalFailure(started.error);
    const { challenge } = started;
    const progress =
      deps.progress ?? ((line: string) => process.stderr.write(`${line}\n`));
    progress(
      `Open ${target.origin}/device and enter the code ${challenge.userCode}`,
    );
    progress(
      `Waiting for the owner to approve; the code expires in ${challenge.expiresIn} seconds.`,
    );
    const text = await pollForCredential(deps, http, challenge, signal);
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
          "The credential was saved. Run forge cloud login again to finish the binding.",
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
  } finally {
    own?.dispose();
  }
}

async function run(
  deps: CloudLoginDeps,
  request: InvocationRequest,
): Promise<ResultEnvelope> {
  try {
    return {
      ok: true,
      op: CLOUD_LOGIN_OP,
      status: "OK",
      result: await login(deps, request),
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      op: CLOUD_LOGIN_OP,
      status: "FAIL",
      error:
        error instanceof ForgeFailure
          ? error.error
          : {
              code: "INTERNAL",
              message: "Login failed unexpectedly.",
              retry: "never",
            },
      warnings: [],
    };
  }
}

/**
 * The catalog with `cloud.login` added. Everything else, including discovery hints, passes through
 * unchanged, so no existing command can reach the cloud through this wrapper.
 */
export function cloudLoginCatalog(
  base: SurfaceCatalog,
  deps: CloudLoginDeps,
): SurfaceCatalog {
  return {
    list: () => [...base.list(), cloudLoginCandidate],
    ...(base.diagnose === undefined
      ? {}
      : { diagnose: (op: string) => base.diagnose?.(op) }),
    ...(base.upgradeHint === undefined
      ? {}
      : { upgradeHint: (op: string) => base.upgradeHint?.(op) }),
    ...(base.templateHint === undefined
      ? {}
      : {
          templateHint: (
            ...args: Parameters<NonNullable<SurfaceCatalog["templateHint"]>>
          ) => base.templateHint?.(...args),
        }),
    invoke: (request) =>
      request.op === CLOUD_LOGIN_OP ? run(deps, request) : base.invoke(request),
  };
}
