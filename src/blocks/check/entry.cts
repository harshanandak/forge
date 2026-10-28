import type { CryptoService, CatalogServices } from "./services.ts";
declare const fail: (code: string, message: string) => never;
function failure(code: string, message: string): never {
  if (typeof fail === "function") return fail(code, message);
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
import type {
  CheckConfig,
  CheckReceipt,
  CheckRun,
  CheckServices,
  CheckStatus,
  CheckInvocationScope,
  RunInput,
  GateInput,
  GateResult,
  MergeResult,
} from "./types.ts";
import type { SpawnOptions } from "../../ports/process.ts";

/** Sorted records make bindings independent of object insertion order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Receipt input must be JSON");
  return encoded;
}

const HASH_LIMIT = 1_048_576;
// The longest supported HEAD is 64 hex bytes followed by up to two newline bytes.
const SNAPSHOT_HEAD_OUTPUT_BYTES = 66;
function utf8Bytes(text: string): number {
  let size = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    size += code <= 127 ? 1 : code <= 2047 ? 2 : code <= 65535 ? 3 : 4;
  }
  return size;
}
function digest(value: unknown, crypto: CryptoService): string {
  const text = canonical(value),
    bytes = utf8Bytes(text);
  if (bytes <= HASH_LIMIT) return `sha256:${crypto.sha256(text)}`;
  // Ordered, domain-separated chunk commitments. Never split a surrogate pair.
  const domain = "forge/check/chunked-sha256/v1";
  let chain = crypto.sha256(domain),
    index = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + Math.floor(HASH_LIMIT / 3));
    if (
      end < text.length &&
      /[\uD800-\uDBFF]/.test(text[end - 1]!) &&
      /[\uDC00-\uDFFF]/.test(text[end]!)
    )
      end--;
    chain = crypto.sha256(
      `${chain}:${index++}:${crypto.sha256(text.slice(start, end))}`,
    );
    start = end;
  }
  return `sha256:${crypto.sha256(`${domain}:${text.length}:${bytes}:${index}:${chain}`)}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return (
    Object.keys(value).sort().join(",") === expected.split(",").sort().join(",")
  );
}
function status(value: unknown): value is CheckStatus {
  return (
    typeof value === "string" &&
    ["PASS", "FAIL", "INCOMPLETE", "NOT_EXECUTED"].includes(value)
  );
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function verify(
  value: unknown,
  expected: string,
  crypto: CryptoService,
): value is CheckReceipt {
  if (
    !isRecord(value) ||
    !keys(
      value,
      "version,id,status,subject,checkedAt,checked,reason,inputsDigest,digest,runs",
    ) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !status(value.status)
  )
    return false;
  if (
    ![value.subject, value.checkedAt, value.reason].every(
      (v) => typeof v === "string" && v.length > 0,
    ) ||
    ![value.inputsDigest, value.digest].every(
      (v) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v),
    )
  )
    return false;
  if (
    !Array.isArray(value.checked) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 256 ||
    value.checked.length !== value.runs.length
  )
    return false;
  for (const [index, run] of value.runs.entries()) {
    if (
      !isRecord(run) ||
      !keys(
        run,
        "name,argv,executable,status,testCount,exitCode,signal,timedOut,truncated,stdout,stderr,stdoutEvidence,stderrEvidence,durationMs,reason",
      ) ||
      typeof run.name !== "string" ||
      !run.name ||
      !status(run.status) ||
      !Array.isArray(run.argv) ||
      !run.argv.every((v) => typeof v === "string")
    )
      return false;
    for (const stream of [run.stdoutEvidence, run.stderrEvidence]) {
      if (stream === null) continue;
      if (
        !isRecord(stream) ||
        !keys(stream, "head,tail,encoding,totalBytes,digest,complete") ||
        stream.encoding !== "base64" ||
        typeof stream.head !== "string" ||
        typeof stream.tail !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          stream.head,
        ) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          stream.tail,
        ) ||
        !integer(stream.totalBytes) ||
        stream.totalBytes < 0 ||
        typeof stream.complete !== "boolean" ||
        typeof stream.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(stream.digest)
      )
        return false;
    }
    if (
      ![run.executable, run.signal].every(
        (v) => v === null || typeof v === "string",
      ) ||
      !(
        run.testCount === null ||
        (integer(run.testCount) && run.testCount >= 0)
      ) ||
      !(run.exitCode === null || integer(run.exitCode)) ||
      typeof run.timedOut !== "boolean" ||
      typeof run.truncated !== "boolean" ||
      ![run.stdout, run.stderr, run.reason].every(
        (v) => typeof v === "string",
      ) ||
      typeof run.durationMs !== "number" ||
      !Number.isFinite(run.durationMs) ||
      run.durationMs < 0
    )
      return false;
    const checked: unknown = value.checked[index];
    if (
      !isRecord(checked) ||
      !keys(checked, "name,status") ||
      checked.name !== run.name ||
      checked.status !== run.status
    )
      return false;
    if (
      run.status === "PASS" &&
      (run.exitCode !== 0 ||
        run.stdoutEvidence === null ||
        run.stderrEvidence === null ||
        !(run.stdoutEvidence as { complete: boolean }).complete ||
        !(run.stderrEvidence as { complete: boolean }).complete ||
        run.timedOut ||
        run.signal !== null ||
        run.testCount === 0)
    )
      return false;
  }
  const receipt = value as unknown as CheckReceipt;
  if (
    receipt.status === "PASS" &&
    (receipt.runs.length === 0 ||
      receipt.runs.some((run) => run.status !== "PASS"))
  )
    return false;
  const { digest: stored, ...body } = value;
  return value.inputsDigest === expected && stored === digest(body, crypto);
}

function blank(
  name: string,
  argv: readonly string[],
  reason: string,
  status: CheckStatus = "NOT_EXECUTED",
): CheckRun {
  return {
    name,
    argv,
    executable: null,
    status,
    testCount: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    truncated: false,
    stdout: "",
    stderr: "",
    stdoutEvidence: null,
    stderrEvidence: null,
    durationMs: 0,
    reason,
  };
}

const INCOMPLETE_REASON =
  "Command could not be completed; inspect the executable and project configuration";
function declarationsFor(
  config: CheckConfig,
  configPath = "blocks.check.config",
) {
  return Object.entries(config.commands).map(([name, command]) => ({
    name,
    argv:
      typeof command === "string"
        ? commandArguments(command, `${configPath}.commands.${name}`)
        : [...command.argv],
  }));
}
function metadataSize(
  config: CheckConfig,
  subject = "",
  paths?: ReadonlyMap<string, string>,
  configPath?: string,
): number {
  const stream = {
    head: "",
    tail: "",
    encoding: "base64",
    totalBytes: Number.MAX_SAFE_INTEGER,
    digest: "sha256:" + "a".repeat(64),
    complete: false,
  };
  const runs = declarationsFor(config, configPath).map(({ name, argv }) => ({
    ...blank(name, argv, INCOMPLETE_REASON, "NOT_EXECUTED"),
    executable: paths?.get(name) ?? argv[0] ?? null,
    testCount: Number.MAX_SAFE_INTEGER,
    exitCode: -Number.MAX_SAFE_INTEGER,
    signal: "\0".repeat(64),
    durationMs: Number.MAX_VALUE,
    stdoutEvidence: stream,
    stderrEvidence: stream,
  }));
  return utf8Bytes(
    canonical({
      version: 1,
      id: "a".repeat(36),
      subject,
      status: "NOT_EXECUTED",
      checkedAt: "0".repeat(24),
      checked: runs.map(({ name, status }) => ({ name, status })),
      reason: "Project inputs changed while checks ran",
      inputsDigest: "sha256:" + "a".repeat(64),
      digest: "sha256:" + "a".repeat(64),
      runs,
    }),
  );
}
/** Pure preflight: no clock, snapshot, environment selection or process calls. */
function validateBudgets(
  config: CheckConfig,
  configPath = "blocks.check.config",
): {
  totalBytes: number;
  declarationBytes: number;
} {
  const invalid = (message: string, key: string, fix: string): never =>
    failure(
      "INPUT_INVALID",
      `.forge/config.yaml: ${configPath}.${key}: ${message}. Fix: ${fix}.`,
    );
  for (const [name, value, maximum] of [
    ["maxOutputBytes", config.maxOutputBytes, 262144],
    ["outputHeadBytes", config.outputHeadBytes, 262144],
    ["outputTailBytes", config.outputTailBytes, 262144],
    ["maxMetadataBytes", config.maxMetadataBytes, HASH_LIMIT],
    ["maxReceiptBytes", config.maxReceiptBytes, HASH_LIMIT],
  ] as const) {
    const minimum =
      name === "outputHeadBytes" || name === "outputTailBytes" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      invalid(
        `${name} must be an integer in ${minimum}..${maximum}; maximum ${maximum}`,
        name,
        `set ${configPath}.${name} to an integer in ${minimum}..${maximum}`,
      );
  }
  const retained = config.outputHeadBytes + config.outputTailBytes;
  if (retained > config.maxOutputBytes)
    invalid(
      `outputHeadBytes + outputTailBytes (${retained}) conflicts with maxOutputBytes (${config.maxOutputBytes}); maximum retained bytes per stream is ${config.maxOutputBytes}`,
      "outputHeadBytes",
      `lower ${configPath}.outputHeadBytes + ${configPath}.outputTailBytes to at most ${config.maxOutputBytes}`,
    );
  const count = Object.keys(config.commands).length;
  if (count > 256)
    invalid(
      "commands exceeds its maximum of 256",
      "commands",
      `keep at most 256 entries in ${configPath}.commands`,
    );
  const declarationBytes = utf8Bytes(canonical(config.commands));
  const metadata = metadataSize(config, "", undefined, configPath);
  const maximumMetadata = Math.max(
    0,
    config.maxReceiptBytes - count * 2 * retained * 10,
  );
  if (metadata > config.maxMetadataBytes)
    invalid(
      `maxMetadataBytes (${config.maxMetadataBytes}) cannot fit declarations (${declarationBytes} bytes) and receipt metadata; needs at least ${metadata}; maximum metadata reservation that fits maxReceiptBytes is ${maximumMetadata}`,
      "maxMetadataBytes",
      `raise ${configPath}.maxMetadataBytes to at least ${metadata}`,
    );
  // JSON text needs at most six bytes per retained raw byte; base64 at most four.
  const totalBytes = config.maxMetadataBytes + count * 2 * retained * 10;
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > config.maxReceiptBytes
  ) {
    const maximum = count
      ? Math.max(
          0,
          Math.floor(
            (config.maxReceiptBytes - config.maxMetadataBytes) /
              (count * 2 * 10),
          ),
        )
      : 0;
    invalid(
      `commands (${count}) × two streams × outputHeadBytes + outputTailBytes (${retained}), plus maxMetadataBytes (${config.maxMetadataBytes}), conflicts with maxReceiptBytes (${config.maxReceiptBytes}); maximum retained bytes per stream is ${maximum}; crypto ceiling is ${HASH_LIMIT}`,
      "maxReceiptBytes",
      `lower ${configPath}.outputHeadBytes + ${configPath}.outputTailBytes to at most ${maximum}`,
    );
  }
  return { totalBytes, declarationBytes };
}
/** The config as one run sees it: only the selected checks count toward its budgets. */
function selectedConfig(
  config: CheckConfig,
  checks: readonly string[] | undefined,
): { names: string[]; config: CheckConfig } {
  const names = [...new Set(checks ?? Object.keys(config.commands))];
  if (names.length > 256 || names.some((name) => !name || name.length > 200))
    failure("INPUT_INVALID", "Select at most 256 named checks");
  return {
    names,
    config: {
      ...config,
      commands: Object.fromEntries(
        names.map((name) => [
          name,
          Object.hasOwn(config.commands, name)
            ? config.commands[name]!
            : { argv: [] },
        ]),
      ),
    },
  };
}
// Native private ACLs: 512 KiB seal/store/readback max 1.20 s under load (5 samples).
// Reserve 1 s overhead plus 128 KiB/s, over four times that measured maximum.
const RECEIPT_FINALIZATION = { baseMs: 1000, bytesPerSecond: 131072 } as const;
function finalizationTimeoutMs(maxReceiptBytes: number): number {
  return (
    RECEIPT_FINALIZATION.baseMs +
    Math.ceil((maxReceiptBytes * 1000) / RECEIPT_FINALIZATION.bytesPerSecond)
  );
}
function runTimeoutMs(
  config: CheckConfig,
  input: RunInput,
  timing: { readonly cleanupMs: number; readonly snapshotMs: number },
  configPath = "blocks.check.config",
): number {
  const selected = selectedConfig(config, input.checks);
  validateBudgets(selected.config, configPath);
  const { cleanupMs, snapshotMs } = timing;
  const finalizationMs = finalizationTimeoutMs(config.maxReceiptBytes);
  const timeoutMs =
    selected.names.length * (config.timeoutMs + cleanupMs) +
    2 * snapshotMs +
    finalizationMs;
  if (
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs > 2_147_483_647
  )
    failure(
      "INPUT_INVALID",
      `Selected commands' timeouts add up to more than the maximum operation timer budget of 2147483.647 s (including ${cleanupMs / 1000} s per command for cleanup and drain, two snapshots at ${snapshotMs / 1000} s each, and ${finalizationMs / 1000} s for finalization); ${configPath}.timeoutMs in .forge/config.yaml is ${config.timeoutMs / 1000} s each for ${selected.names.length} selected commands. Fix: lower ${configPath}.timeoutMs or select fewer checks with --input '{"checks":["name"]}'.`,
    );
  return timeoutMs;
}
function aggregate(runs: readonly CheckRun[]): CheckStatus {
  if (runs.some((run) => run.status === "FAIL")) return "FAIL";
  if (runs.some((run) => run.status === "INCOMPLETE")) return "INCOMPLETE";
  if (runs.length === 0 || runs.some((run) => run.status === "NOT_EXECUTED"))
    return "NOT_EXECUTED";
  return "PASS";
}
interface CheckBlock {
  gate(
    input: GateInput,
    config: CheckConfig,
    scope?: CheckInvocationScope,
  ): Promise<GateResult>;
  list(config: CheckConfig): string[];
  show(id: string): CheckReceipt | undefined;
  run(
    input: RunInput,
    config: CheckConfig,
    scope?: CheckInvocationScope,
  ): Promise<CheckReceipt>;
}
function createCheck(
  services: CheckServices & { readonly crypto: CryptoService },
): CheckBlock {
  const hash = (value: unknown) => digest(value, services.crypto);
  const verifyReceipt = (
    value: unknown,
    expected: string,
  ): value is CheckReceipt => verify(value, expected, services.crypto);
  const randomUUID = () => services.crypto.randomUUID();
  const structuredClone = copy;
  const invalid = (message: string): never => failure("INPUT_INVALID", message);
  function show(id: string): CheckReceipt | undefined {
    const record = services.state.get(`runs/${id}`);
    if (!record) return undefined;
    const value = record.value;
    const expected =
      typeof value === "object" && value !== null && "inputsDigest" in value
        ? value.inputsDigest
        : undefined;
    if (typeof expected !== "string" || !verifyReceipt(value, expected))
      failure("INPUT_CONFLICT", "Check receipt integrity failed");
    return value;
  }
  return {
    gate(input, config, scope) {
      return gate(services, input, config, scope);
    },
    list(config: CheckConfig) {
      return Object.keys(config.commands);
    },
    show,
    async run(
      input: RunInput,
      config: CheckConfig,
      scope?: CheckInvocationScope,
    ): Promise<CheckReceipt> {
      function active(): void {
        if (scope?.signal.aborted)
          failure("INVOCATION_CANCELLED", "Check invocation was cancelled");
        if (scope && services.clock.now() >= scope.deadline)
          failure("INVOCATION_TIMEOUT", "Check invocation deadline exceeded");
      }
      if (scope && !Number.isSafeInteger(scope.deadline))
        invalid("Invocation deadline must be an integer timestamp");
      active();
      if (
        !Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 1 ||
        config.timeoutMs > 2_147_483_647
      )
        invalid("timeoutMs must be a positive timer budget");
      const frozenConfig = structuredClone(config);
      const frozenInput = structuredClone(input);
      const env = Object.freeze({ ...services.environment });
      const { names, config: budgetConfig } = selectedConfig(
        frozenConfig,
        frozenInput.checks,
      );
      validateBudgets(budgetConfig);
      const before = structuredClone(await services.snapshot());
      active();
      const declarations = names.map((name) => {
        const command = Object.hasOwn(frozenConfig.commands, name)
          ? frozenConfig.commands[name]
          : undefined;
        const argv =
          typeof command === "string"
            ? commandArguments(command)
            : [...(command?.argv ?? [])];
        if (
          command !== undefined &&
          (!argv[0] ||
            argv.some((arg) => typeof arg !== "string" || arg.includes("\0")))
        )
          invalid(
            "Declared argument arrays need an executable and contain no NUL bytes",
          );
        const executable = argv[0]
          ? services.process.resolve(argv[0], env)
          : undefined;
        return {
          name,
          argv,
          executable,
          report:
            typeof command === "object"
              ? (command.report ?? frozenConfig.report)
              : frozenConfig.report,
        };
      });
      const inputsDigest = hash({
        snapshot: before,
        root: services.root,
        environmentDigest: hash(env),
        config: frozenConfig,
        trigger: frozenInput.trigger ?? null,
        declarations: declarations.map(
          ({ name, argv, executable, report }) => ({
            name,
            argv,
            executable:
              executable?.kind === "resolved" ? executable.path : null,
            report,
          }),
        ),
      });
      const paths = new Map(
        declarations
          .filter((d) => d.executable?.kind === "resolved")
          .map((d) => [
            d.name,
            d.executable!.kind === "resolved" ? d.executable!.path : "",
          ]),
      );
      const requiredMetadata = metadataSize(budgetConfig, before.head, paths);
      if (requiredMetadata > frozenConfig.maxMetadataBytes)
        invalid(
          `maxMetadataBytes (${frozenConfig.maxMetadataBytes}) cannot fit resolved declaration metadata; needs at least ${requiredMetadata}; maximum metadata reservation that fits maxReceiptBytes is ${Math.max(0, frozenConfig.maxReceiptBytes - names.length * 2 * (frozenConfig.outputHeadBytes + frozenConfig.outputTailBytes) * 10)}`,
        );
      const runs: CheckRun[] = [];
      for (const declaration of declarations) {
        active();
        const { name, argv, executable, report } = declaration;
        if (
          frozenConfig.stopOnFailure &&
          runs.some((run) => run.status !== "PASS")
        ) {
          runs.push(blank(name, argv, "An earlier check did not pass"));
          continue;
        }
        if (!executable) {
          runs.push(blank(name, argv, "No command declared"));
          continue;
        }
        if (executable.kind === "unavailable") {
          runs.push(
            blank(
              name,
              argv,
              "Executable is unavailable; inspect the declared command and environment",
              "INCOMPLETE",
            ),
          );
          continue;
        }
        try {
          // The verdict comes from every output byte; retained head and tail are display only.
          const recognizer = services.output.recognize(report);
          const options: SpawnOptions = {
            cwd: services.root,
            env: { ...env },
            timeoutMs: scope
              ? Math.min(
                  frozenConfig.timeoutMs,
                  scope.deadline - services.clock.now(),
                )
              : frozenConfig.timeoutMs,
            maxOutputBytes: frozenConfig.maxOutputBytes,
            capture: {
              headBytes: frozenConfig.outputHeadBytes,
              tailBytes: frozenConfig.outputTailBytes,
            },
            observer: recognizer,
            ...(scope ? { signal: scope.signal } : {}),
          };
          const result = await services.process.run(
            executable,
            argv.slice(1),
            options,
          );
          active();
          if (!result.outputEvidence)
            throw new Error(
              "Process service did not supply streaming evidence",
            );
          const seen = recognizer.observed();
          const incompleteOutput =
            !result.outputEvidence.stdout.complete ||
            !result.outputEvidence.stderr.complete ||
            seen.stdout !== result.outputEvidence.stdout.totalBytes ||
            seen.stderr !== result.outputEvidence.stderr.totalBytes;
          const parsed = incompleteOutput
            ? { kind: "unknown" as const, testCount: null, failed: null }
            : recognizer.report();
          const status: CheckStatus =
            result.timedOut ||
            incompleteOutput ||
            result.signal !== null ||
            result.exitCode === null ||
            parsed.kind === "malformed"
              ? "INCOMPLETE"
              : parsed.testCount === 0 ||
                  (parsed.failed ?? 0) > 0 ||
                  result.exitCode !== 0
                ? "FAIL"
                : "PASS";
          runs.push({
            name,
            argv,
            executable: executable.path,
            exitCode: result.exitCode,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutEvidence: result.outputEvidence.stdout,
            stderrEvidence: result.outputEvidence.stderr,
            timedOut: result.timedOut,
            truncated: result.truncated,
            durationMs: result.durationMs,
            status,
            testCount: parsed.testCount,
            reason: result.timedOut
              ? "Command exceeded its time budget; retained output follows"
              : incompleteOutput
                ? "Output was not observed in full"
                : `Output report: ${parsed.kind}${result.truncated ? "; retained output is truncated for display" : ""}`,
          });
        } catch {
          active();
          runs.push({
            ...blank(name, argv, INCOMPLETE_REASON, "INCOMPLETE"),
            executable: executable.path,
          });
        }
      }
      active();
      const after = await services.snapshot();
      active();
      // The invocation already reserves finalization time, including storage contention.
      const finalizationDeadline =
        scope?.deadline ??
        services.clock.now() +
          finalizationTimeoutMs(frozenConfig.maxReceiptBytes);
      const changed = hash(before) !== hash(after);
      const status = changed ? "INCOMPLETE" : aggregate(runs);
      const body = {
        version: 1 as const,
        id: randomUUID(),
        status,
        subject: before.head,
        checkedAt: new Date(services.clock.now()).toISOString(),
        checked: runs.map(({ name, status }) => ({ name, status })),
        reason: changed
          ? "Project inputs changed while checks ran"
          : runs.length
            ? "Results of declared commands"
            : "No commands declared",
        inputsDigest,
        runs,
      };
      const receipt: CheckReceipt = { ...body, digest: hash(body) };
      if (utf8Bytes(canonical(receipt)) > frozenConfig.maxReceiptBytes)
        failure(
          "LIMIT_EXCEEDED",
          "Process evidence exceeded its validated receipt budget",
        );
      services.state.put(`runs/${receipt.id}`, receipt, { expectRevision: 0 });
      const stored = show(receipt.id);
      if (!stored || stored.digest !== receipt.digest)
        throw new Error("Check receipt readback failed");
      active();
      if (services.clock.now() >= finalizationDeadline)
        failure(
          "INVOCATION_TIMEOUT",
          "Check receipt finalization deadline exceeded",
        );
      return stored;
    },
  };
}

/** Split a declared executable invocation, never evaluate shell syntax. */
function commandArguments(text: string, configPath?: string): string[] {
  const invalid = (message: string): never => failure("INPUT_INVALID", message);
  let problem: string | undefined;
  const args: string[] = [];
  let value = "",
    quote = "",
    started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(value);
        value = "";
        started = false;
      }
    } else {
      if (/[|&;<>`$\r\n]/.test(char))
        problem ??=
          "Shell syntax needs a project-owned script; declare an argument array instead.";
      value += char;
      started = true;
    }
  }
  if (quote) problem ??= "Declared command contains an unclosed quote.";
  if (started) args.push(value);
  if (!args[0]) problem ??= "Declared command has no executable.";
  if (problem)
    invalid(
      configPath === undefined
        ? problem
        : `.forge/config.yaml: ${configPath}: ${problem} Got ${JSON.stringify(text)}. Fix: use ${JSON.stringify({ argv: args.length ? args : ["executable"] })}; put shell behavior in a project-owned script.`,
    );
  return args;
}

function doorMatches(path: string, glob: string): boolean {
  let pattern = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        pattern += "(?:.*/)?";
        i++;
      } else pattern += ".*";
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`).test(path);
}

const THREAD_QUERY =
  "query($owner:String!,$repo:String!,$n:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{id isResolved}}}}}";
const CHECK_QUERY =
  "query($owner:String!,$repo:String!,$n:Int!,$head:GitObjectID!,$endCursor:String){repository(owner:$owner,name:$repo){object(oid:$head){... on Commit{oid statusCheckRollup{contexts(first:100,after:$endCursor){totalCount pageInfo{hasNextPage endCursor} nodes{__typename ... on CheckRun{name status conclusion isRequired(pullRequestNumber:$n)} ... on StatusContext{context state isRequired(pullRequestNumber:$n)}}}}}}}}";

async function gate(
  services: Pick<
    CheckServices,
    "process" | "state" | "root" | "environment" | "clock"
  > & { readonly crypto: CryptoService },
  input: GateInput,
  config: CheckConfig,
  scope?: CheckInvocationScope,
): Promise<GateResult> {
  const reasons: { code: string; detail: string }[] = [];
  const checks: { name: string; state: string }[] = [];
  const doors: string[] = [];
  let head = "",
    receipt: string | undefined,
    unresolvedThreads = 0;
  const refuse = (code: string, detail: string) => {
    reasons.push({ code, detail });
  };
  const deadline = scope?.deadline ?? services.clock.now() + 60000;
  let timedOut = false;
  function active() {
    if (
      !Number.isSafeInteger(deadline) ||
      scope?.signal.aborted ||
      services.clock.now() >= deadline
    )
      throw new Error("Gate invocation cancelled or expired");
  }
  function invalid(): never {
    throw new Error("Invalid GitHub evidence");
  }
  async function gh(
    args: readonly string[],
    allowedExits: readonly number[] = [0],
  ): Promise<string> {
    active();
    const executable = services.process.resolve("gh", services.environment);
    if (executable.kind !== "resolved")
      throw new Error("GitHub CLI unavailable");
    const result = await services.process.run(executable, args, {
      cwd: services.root,
      env: { ...services.environment },
      timeoutMs: Math.max(
        1,
        Math.min(config.timeoutMs, deadline - services.clock.now()),
      ),
      maxOutputBytes: 262144,
      ...(scope ? { signal: scope.signal } : {}),
    });
    timedOut = result.timedOut;
    active();
    if (
      result.exitCode === null ||
      !allowedExits.includes(result.exitCode) ||
      result.signal !== null ||
      result.timedOut ||
      result.truncated ||
      (result.outputEvidence &&
        (!result.outputEvidence.stdout.complete ||
          !result.outputEvidence.stderr.complete))
    )
      throw new Error("GitHub command did not complete successfully");
    return result.stdout;
  }
  async function view() {
    const value: unknown = JSON.parse(
      await gh([
        "pr",
        "view",
        String(input.pr),
        "--json",
        "headRefOid,headRefName,baseRefOid,state,mergeStateStatus,url,changedFiles",
      ]),
    );
    if (
      !isRecord(value) ||
      typeof value.headRefOid !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.headRefOid) ||
      typeof value.headRefName !== "string" ||
      value.headRefName.trim().length === 0 ||
      typeof value.baseRefOid !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseRefOid) ||
      typeof value.state !== "string" ||
      typeof value.mergeStateStatus !== "string" ||
      typeof value.url !== "string" ||
      !integer(value.changedFiles) ||
      value.changedFiles < 0 ||
      value.changedFiles > 300
    )
      invalid();
    return value as {
      headRefOid: string;
      headRefName: string;
      baseRefOid: string;
      state: string;
      mergeStateStatus: string;
      url: string;
      changedFiles: number;
    };
  }
  try {
    if (!Number.isSafeInteger(input.pr) || input.pr < 1) invalid();
    const pr = await view();
    head = pr.headRefOid;
    if (pr.headRefName.toLowerCase().startsWith("prototype/"))
      refuse(
        "PROTOTYPE_BRANCH",
        `${pr.headRefName}: prototype branches never merge; port the decision into a slice`,
      );
    if (pr.state !== "OPEN" || pr.mergeStateStatus !== "CLEAN")
      refuse(
        "PR_NOT_MERGEABLE",
        "Pull request must be OPEN with merge state CLEAN",
      );
    const candidates = services.state.list("runs/");
    const verified = candidates.flatMap((record) => {
      const value = record.value;
      return isRecord(value) &&
        typeof value.inputsDigest === "string" &&
        verify(value, value.inputsDigest, services.crypto) &&
        record.key === `runs/${value.id}` &&
        Number.isFinite(Date.parse(value.checkedAt))
        ? [value]
        : [];
    });
    const current = verified.filter((value) => value.subject === head);
    const passing = current.filter((value) => value.status === "PASS");
    const receiptChecks = config.gate?.receiptChecks ?? [];
    const eligible = passing.filter(
      (value) =>
        value.runs.length > 0 &&
        receiptChecks.every((name) =>
          value.checked.some(
            (check) => check.name === name && check.status === "PASS",
          ),
        ),
    );
    eligible.sort(
      (a, b) =>
        Date.parse(b.checkedAt) - Date.parse(a.checkedAt) ||
        b.id.localeCompare(a.id),
    );
    receipt = eligible[0]?.id;
    if (!receipt) {
      const code = !candidates.length
        ? "RECEIPT_MISSING"
        : !verified.length
          ? "RECEIPT_INVALID"
          : !current.length
            ? "RECEIPT_HEAD_MISMATCH"
            : !passing.length
              ? "RECEIPT_NOT_PASS"
              : "RECEIPT_CHECK_MISSING";
      refuse(
        code,
        "No verified PASS receipt for this head covers all configured receipt checks",
      );
    }
    const required = config.gate?.requiredChecks ?? "github-required";
    const repository =
      /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(pr.url);
    if (!repository || Number(repository[4]) !== input.pr) invalid();
    const checkPages: unknown = JSON.parse(
      await gh([
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "--hostname",
        repository[1]!,
        "-F",
        `owner=${repository[2]}`,
        "-F",
        `repo=${repository[3]}`,
        "-F",
        `n=${input.pr}`,
        "-F",
        `head=${head}`,
        "-f",
        `query=${CHECK_QUERY}`,
      ]),
    );
    if (!Array.isArray(checkPages) || !checkPages.length) invalid();
    let checkCount = 0;
    let expectedChecks: number | undefined;
    const checkCursors = new Set<string>();
    for (const [index, page] of checkPages.entries()) {
      if (
        !isRecord(page) ||
        "errors" in page ||
        !isRecord(page.data) ||
        !isRecord(page.data.repository) ||
        !isRecord(page.data.repository.object)
      )
        invalid();
      const commit = page.data.repository.object;
      if (commit.oid !== head || !isRecord(commit.statusCheckRollup)) invalid();
      const contexts = commit.statusCheckRollup.contexts;
      if (
        !isRecord(contexts) ||
        !Array.isArray(contexts.nodes) ||
        !integer(contexts.totalCount) ||
        contexts.totalCount < 0 ||
        !isRecord(contexts.pageInfo)
      )
        invalid();
      expectedChecks ??= contexts.totalCount;
      if (contexts.totalCount !== expectedChecks) invalid();
      const info = contexts.pageInfo;
      if (
        info.hasNextPage !== index < checkPages.length - 1 ||
        !(info.endCursor === null || typeof info.endCursor === "string")
      )
        invalid();
      if (info.hasNextPage) {
        if (
          typeof info.endCursor !== "string" ||
          !info.endCursor ||
          checkCursors.has(info.endCursor)
        )
          invalid();
        checkCursors.add(info.endCursor);
      }
      for (const value of contexts.nodes) {
        if (!isRecord(value) || typeof value.isRequired !== "boolean")
          invalid();
        const run = value.__typename === "CheckRun";
        if (!run && value.__typename !== "StatusContext") invalid();
        const name = run ? value.name : value.context;
        const state =
          run && value.status === "COMPLETED"
            ? value.conclusion
            : (value.state ?? value.status);
        if (
          typeof name !== "string" ||
          !name ||
          typeof state !== "string" ||
          !state
        )
          invalid();
        checkCount++;
        if (
          required === "github-required"
            ? value.isRequired
            : required.includes(name)
        ) {
          checks.push({ name, state });
          if (state !== "SUCCESS" || (run && value.status !== "COMPLETED"))
            refuse(
              "REQUIRED_CHECK_FAILED",
              `Required check ${name} is not SUCCESS`,
            );
        }
      }
    }
    if (checkCount !== expectedChecks) invalid();
    if (required !== "github-required")
      for (const name of required) {
        if (!checks.some((check) => check.name === name))
          refuse("REQUIRED_CHECK_MISSING", `Required check ${name} is absent`);
      }
    if (!checks.length)
      refuse(
        "REQUIRED_CHECKS_EMPTY",
        "Required checks must resolve to a nonempty list",
      );
    const pages: unknown = JSON.parse(
      await gh([
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "--hostname",
        repository[1]!,
        "-F",
        `owner=${repository[2]}`,
        "-F",
        `repo=${repository[3]}`,
        "-F",
        `n=${input.pr}`,
        "-f",
        `query=${THREAD_QUERY}`,
      ]),
    );
    if (!Array.isArray(pages) || pages.length === 0) invalid();
    const cursors = new Set<string>();
    for (const [index, page] of pages.entries()) {
      if (
        !isRecord(page) ||
        "errors" in page ||
        !isRecord(page.data) ||
        !isRecord(page.data.repository) ||
        !isRecord(page.data.repository.pullRequest)
      )
        invalid();
      const threads = page.data.repository.pullRequest.reviewThreads;
      if (
        !isRecord(threads) ||
        !Array.isArray(threads.nodes) ||
        !isRecord(threads.pageInfo)
      )
        invalid();
      const info = threads.pageInfo;
      if (
        info.hasNextPage !== index < pages.length - 1 ||
        !(info.endCursor === null || typeof info.endCursor === "string")
      )
        invalid();
      if (info.hasNextPage) {
        if (
          typeof info.endCursor !== "string" ||
          !info.endCursor ||
          cursors.has(info.endCursor)
        )
          invalid();
        cursors.add(info.endCursor);
      }
      for (const node of threads.nodes) {
        if (
          !isRecord(node) ||
          typeof node.id !== "string" ||
          !node.id ||
          typeof node.isResolved !== "boolean"
        )
          invalid();
        if (!node.isResolved) unresolvedThreads++;
      }
    }
    if (unresolvedThreads)
      refuse(
        "UNRESOLVED_THREADS",
        `${unresolvedThreads} unresolved review thread(s)`,
      );
    const filePages: unknown = JSON.parse(
      await gh([
        "api",
        `repos/${repository[2]}/${repository[3]}/compare/${pr.baseRefOid}...${head}?per_page=100`,
        "--paginate",
        "--slurp",
        "--hostname",
        repository[1]!,
      ]),
    );
    if (!Array.isArray(filePages) || filePages.length === 0) invalid();
    const filenames = new Set<string>();
    for (const [index, page] of filePages.entries()) {
      if (
        !isRecord(page) ||
        !isRecord(page.base_commit) ||
        page.base_commit.sha !== pr.baseRefOid
      )
        invalid();
      // Compare returns all files on page one, capped at 300; later pages contain commits only.
      if (index > 0) {
        if (page.files !== undefined) invalid();
        continue;
      }
      if (!Array.isArray(page.files) || page.files.length > 300) invalid();
      for (const file of page.files) {
        if (
          !isRecord(file) ||
          typeof file.filename !== "string" ||
          !file.filename.trim() ||
          typeof file.status !== "string" ||
          ![
            "added",
            "removed",
            "modified",
            "renamed",
            "copied",
            "changed",
            "unchanged",
          ].includes(file.status) ||
          filenames.has(file.filename) ||
          (file.status === "renamed" &&
            (typeof file.previous_filename !== "string" ||
              !file.previous_filename.trim())) ||
          (file.previous_filename !== undefined &&
            (typeof file.previous_filename !== "string" ||
              !file.previous_filename.trim()))
        )
          invalid();
        filenames.add(file.filename);
        for (const path of [file.filename, file.previous_filename]) {
          if (path === undefined) continue;
          if (
            typeof path !== "string" ||
            path.startsWith("/") ||
            path.includes("\\") ||
            [...path].some((char) => char.charCodeAt(0) < 32) ||
            path.split("/").includes("..")
          )
            invalid();
          if (
            (config.gate?.doorPaths ?? []).some((glob) =>
              doorMatches(path, glob),
            ) &&
            !doors.includes(path)
          )
            doors.push(path);
        }
      }
    }
    if (filenames.size !== pr.changedFiles) invalid();
    if (doors.length)
      refuse(
        "DOOR_PATH_TOUCHED",
        "Pull request changes configured door paths; owner review is required",
      );
    const after = await view();
    if (after.headRefOid !== head)
      refuse(
        "HEAD_MOVED",
        "Pull request head changed while the gate read evidence",
      );
    if (after.baseRefOid !== pr.baseRefOid)
      refuse(
        "BASE_MOVED",
        "Pull request base changed while the gate read evidence",
      );
    if (after.state !== "OPEN" || after.mergeStateStatus !== "CLEAN")
      refuse("PR_NOT_MERGEABLE", "Pull request is no longer OPEN and CLEAN");
  } catch {
    if (timedOut || services.clock.now() >= deadline)
      refuse(
        "INVOCATION_TIMEOUT",
        "Gate invocation timed out; increase its deadline or GitHub command timeout",
      );
    else if (scope?.signal.aborted)
      refuse("INVOCATION_CANCELLED", "Gate invocation cancelled");
    else
      refuse(
        "GITHUB_EVIDENCE_INVALID",
        "Gate evidence could not be read completely and verified; retry after repairing the CLI, access or response",
      );
  }
  return {
    verdict: reasons.length ? "REFUSED" : "PASS",
    head,
    ...(receipt ? { receipt } : {}),
    checks,
    unresolvedThreads,
    doorPaths: doors,
    reasons,
  };
}

function gateServices(args: Call<GateInput>) {
  const services = args.services;
  return {
    process: services.process,
    state: services.state,
    crypto: services.crypto,
    root: services.files.root,
    environment: services.environment.select([
      ...new Set([
        ...args.config.environment,
        "GH_TOKEN",
        "GH_HOST",
        "GH_ENTERPRISE_TOKEN",
      ]),
    ]),
    clock: { now: () => Date.now() },
  };
}

const MERGE_COMMAND = ["pr", "merge"] as const;
const MERGE_FLAGS = ["--squash", "--match-head-commit"] as const;
async function prMerge(args: Call<GateInput>): Promise<MergeResult> {
  function active() {
    if (args.signal.aborted)
      failure("INVOCATION_CANCELLED", "Merge invocation cancelled");
    if (!Number.isSafeInteger(args.deadline) || Date.now() >= args.deadline)
      failure("INVOCATION_TIMEOUT", "Merge invocation deadline exceeded");
  }
  active();
  const services = gateServices(args);
  const cleanupMs = args.services.process.cleanupBudgetMs ?? 10250;
  const finalizationMs = 1000;
  const readbackBudgetMs = 10000 + cleanupMs + finalizationMs;
  const evidence = await gate(services, args.input, args.config, {
    signal: args.signal,
    deadline: args.deadline - 25000 - cleanupMs - readbackBudgetMs,
  });
  active();
  let result: MergeResult = {
    outcome: "MERGE_UNVERIFIED",
    pr: args.input.pr,
    head: evidence.head,
    gate: evidence,
    ...(evidence.receipt ? { receipt: evidence.receipt } : {}),
  };
  const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  if (
    evidence.verdict !== "PASS" ||
    !oid.test(evidence.head) ||
    !evidence.receipt
  )
    return { ...result, outcome: "REFUSED" };
  async function gh(argv: readonly string[], timeoutMs: number) {
    const executable = services.process.resolve("gh", services.environment);
    if (executable.kind !== "resolved")
      throw new Error("GitHub CLI unavailable");
    return await services.process.run(executable, argv, {
      cwd: services.root,
      env: services.environment,
      signal: args.signal,
      timeoutMs,
      maxOutputBytes: 262144,
    });
  }
  active();
  const mergeTimeout = Math.min(
    25000,
    args.deadline - Date.now() - cleanupMs - readbackBudgetMs,
  );
  if (mergeTimeout <= 0)
    failure("INVOCATION_TIMEOUT", "Insufficient time for merge and readback");
  let merge: Awaited<ReturnType<typeof gh>> | undefined;
  try {
    args.services.process.retainMergeOutcome?.(result);
    merge = await gh(
      [...MERGE_COMMAND, String(args.input.pr), ...MERGE_FLAGS, evidence.head],
      mergeTimeout,
    );
  } catch {
    // The write may have reached GitHub; only readback can establish its outcome.
  }
  try {
    const remaining = args.deadline - Date.now() - cleanupMs - finalizationMs;
    if (remaining <= 0) throw new Error("Readback deadline exceeded");
    const read = await gh(
      [
        "pr",
        "view",
        String(args.input.pr),
        "--json",
        "state,headRefOid,mergeCommit",
      ],
      Math.min(10000, remaining),
    );
    result = {
      ...result,
      readbackProcess: {
        exitCode: read.exitCode,
        signal: read.signal,
        timedOut: read.timedOut,
        truncated:
          read.truncated ||
          read.stdout.length > 2048 ||
          read.stderr.length > 2048,
        stdout: read.stdout.slice(0, 2048),
        stderr: read.stderr.slice(0, 2048),
      },
    };
    args.services.process.retainMergeOutcome?.(result);
    if (
      read.exitCode !== 0 ||
      read.signal !== null ||
      read.timedOut ||
      read.truncated ||
      Object.values(read.outputEvidence ?? {}).some(
        (stream) => !stream.complete,
      )
    )
      throw new Error("Incomplete merge readback");
    const value: unknown = JSON.parse(read.stdout);
    if (
      !isRecord(value) ||
      typeof value.state !== "string" ||
      !["OPEN", "CLOSED", "MERGED"].includes(value.state) ||
      typeof value.headRefOid !== "string" ||
      !oid.test(value.headRefOid) ||
      !(
        value.mergeCommit === null ||
        (isRecord(value.mergeCommit) &&
          typeof value.mergeCommit.oid === "string" &&
          oid.test(value.mergeCommit.oid))
      )
    )
      throw new Error("Invalid merge readback");
    if (value.state === "MERGED") {
      if (value.headRefOid === evidence.head && isRecord(value.mergeCommit))
        return {
          ...result,
          outcome: "MERGED",
          mergeCommit: value.mergeCommit.oid as string,
        };
    } else if (
      merge &&
      merge.exitCode !== null &&
      merge.exitCode !== 0 &&
      !merge.timedOut &&
      merge.signal === null
    )
      return {
        ...result,
        outcome:
          value.headRefOid !== evidence.head ? "HEAD_MOVED" : "MERGE_REFUSED",
        detail: merge.stderr.slice(0, 300),
      };
  } catch {
    // A failed or malformed read cannot prove whether the write happened.
  }
  return { ...result, outcome: "MERGE_UNVERIFIED" };
}

function watchToken(text: string, decode = false): string {
  const base =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const input = decode
    ? text
    : text.replace(
        /[\u0080-\uffff]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
  let bits = 0,
    size = 0,
    output = "";
  const width = decode ? 6 : 8,
    unit = 14 - width;
  for (const char of input) {
    bits = (bits << width) | (decode ? base.indexOf(char) : char.charCodeAt(0));
    for (size += width; size >= unit; size -= unit) {
      const value = (bits >> (size - unit)) & ((1 << unit) - 1);
      output += decode ? String.fromCharCode(value) : base[value];
    }
  }
  if (!decode && size) output += base[(bits << (6 - size)) & 63];
  return output;
}
async function prState(args: Call<{ pr: number; since?: string }>) {
  const { services, input } = args;
  const env = services.environment.select([
    ...args.config.environment,
    ...["GH_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN"],
  ]);
  async function gh<T>(argv: string[], checks = false): Promise<T> {
    const executable = services.process.resolve("gh", env);
    if (executable.kind !== "resolved") throw new Error("gh unavailable");
    const result = await services.process.run(executable, argv, {
      cwd: services.files.root,
      env,
      signal: args.signal,
      timeoutMs: Math.max(1, args.deadline - Date.now()),
      maxOutputBytes: 262144,
    });
    const cut = Object.values(result.outputEvidence ?? {}).some(
      (e) => !e.complete,
    );
    if (result.timedOut || result.truncated || result.signal || cut)
      throw new Error("Incomplete GitHub read");
    const empty =
      /^no (?:required )?checks reported on the '[^\r\n]*' branch\r?\n?$/;
    const absent = checks && !result.stdout && empty.test(result.stderr);
    if (absent && result.exitCode === 1) return [] as T;
    if (!(checks ? [0, 1, 8] : [0]).includes(result.exitCode ?? -1))
      throw new Error("GitHub read failed");
    if (argv.includes("--paginate"))
      return result.stdout
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => JSON.parse(line) as unknown) as T;
    return JSON.parse(result.stdout) as T;
  }
  type Remark = { id: string; author: string; time: string };
  type Pr = Record<string, string> & { draft: boolean; remarks: Remark[] };
  const viewArgs = ["pr", "view", String(input.pr), "--json"];
  const pr = await gh<Pr>([
    ...viewArgs,
    "headRefOid,state,mergeable,mergeStateStatus,reviewDecision,isDraft,url,comments,reviews",
    "--jq",
    "{head:.headRefOid,state,mergeable,merge:.mergeStateStatus,review:.reviewDecision,draft:.isDraft,url,remarks:([.comments[]|{id,author:.author.login,time:.createdAt}]+[.reviews[]|select(.submittedAt)|{id,author:.author.login,time:.submittedAt}])}",
  ]);
  const [, , host, owner, repo] = pr.url!.split("/");
  const hash = (v: unknown) => services.crypto.sha256(JSON.stringify(v));
  type Cursor = Record<"r" | "h" | "t" | "v" | "u", string> &
    Record<"p" | "c", boolean> &
    Record<"f" | "i", string[]> & { n: number };
  const previous = input.since
    ? (JSON.parse(watchToken(input.since, true)) as Cursor)
    : undefined;
  if (previous && previous.r !== hash(pr.url))
    throw new Error("Wrong pull request");
  const old = previous?.h === pr.head ? previous : undefined;
  type Check = { name: string; bucket: string };
  const checkArgs = ["pr", "checks", String(input.pr), "--json", "name,bucket"];
  const checks = await gh<Check[]>(checkArgs, true),
    required = await gh<Check[]>([...checkArgs, "--required"], true);
  const paging = ["--hostname", host!, "--paginate", "--jq"];
  const api = <T,>(path: string, jq: string, fields: string[] = []) =>
    gh<T>(["api", path, ...paging, jq, ...fields]);
  type Page = Record<"queued" | "more", boolean> & {
    viewer: string;
    ids: string[];
  };
  const query =
    "query($owner:String!,$repo:String!,$n:Int!,$endCursor:String){viewer{login} repository(owner:$owner,name:$repo){pullRequest(number:$n){mergeQueueEntry{id} reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{id isResolved}}}}}";
  const fields = [`owner=${owner}`, `repo=${repo}`, `n=${input.pr}`].flatMap(
    (value) => ["-F", value],
  );
  const pages = await api<Page[]>(
    "graphql",
    "(if .errors then error(.errors) else .data | {viewer:.viewer.login,queued:(.repository.pullRequest.mergeQueueEntry!=null),ids:[.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved|not)|.id],more:.repository.pullRequest.reviewThreads.pageInfo.hasNextPage} end) | @json",
    ["-f", `query=${query}`, ...fields],
  );
  if (
    !pages.length ||
    pages.some((page, index) => page.more !== index < pages.length - 1)
  )
    throw new Error("Incomplete threads");
  const threads = pages.flatMap((page) => page.ids).sort();
  const threadHash = hash(threads);
  const inline = await api<Remark[]>(
    `repos/${owner}/${repo}/pulls/${input.pr}/comments?per_page=100`,
    "[.[]|{id:(.id|tostring),author:(.user.login // (.user|tostring)),time:.created_at}] | @json",
  );
  const current = await gh<Record<string, string>>([
    ...viewArgs,
    "headRefOid,state",
  ]);
  const moved = current.headRefOid !== pr.head,
    raced = moved || current.state !== pr.state;
  const remembered = moved ? undefined : old;
  const remarks = [...pr.remarks, ...inline].filter(
    (item) => item.author !== pages[0]!.viewer,
  );
  for (const item of remarks) item.time = new Date(item.time).toISOString();
  const failed = checks.filter(
      (check) => check.bucket === "fail" || check.bucket === "cancel",
    ),
    pending = checks.some((check) => check.bucket === "pending");
  const green = (required.length ? required : checks).every(
    (check) => check.bucket === "pass" || check.bucket === "skipping",
  );
  const passed = checks.length > 0 && green && pr.merge !== "BLOCKED";
  const mergeReady =
    !pages[0]!.queued &&
    pr.mergeable !== "UNKNOWN" &&
    ["CLEAN", "HAS_HOOKS"].includes(pr.merge!);
  const conflicting =
    pr.mergeable === "CONFLICTING" ||
    pr.merge === "DIRTY" ||
    (pr.mergeable === "UNKNOWN" && !!old?.c);
  const reasons = failed.map((check) => `check failed: ${check.name}`);
  if (threads.length) reasons.unshift(`${threads.length} unresolved threads`);
  if (conflicting) reasons.unshift("conflicting");
  if (pr.draft) reasons.push("draft");
  if (pr.review === "CHANGES_REQUESTED") reasons.push("changes requested");
  if (pr.merge === "BEHIND") reasons.push("branch behind");
  if (pr.merge === "BLOCKED" && !pending && !failed.length)
    reasons.push("GitHub BLOCKED: missing required check or approval");
  let verdict = "waiting";
  if (checks.length && green && !pending && mergeReady) verdict = "ready";
  if (reasons.length) verdict = "blocked";
  if (!checks.length) reasons.push("no checks reported");
  if (pr.state !== "OPEN") verdict = "gone";
  const state = hash([pr.state, verdict, reasons]),
    news: string[] = [];
  if (!old) news.push("head moved");
  for (const check of failed)
    if (!old?.f.includes(check.name)) news.push(`check failed: ${check.name}`);
  if (passed && !old?.p) news.push("required checks passed");
  const fresh = remarks.filter(
    (item) =>
      !previous ||
      item.time > previous.t ||
      (item.time === previous.t && !previous.i.includes(item.id)),
  );
  if (fresh.length)
    news.push(
      `${fresh.length} new remarks: ${[...new Set(fresh.map((item) => item.author))].sort().join(", ")}`,
    );
  if (conflicting && !previous?.c) news.push("conflicting");
  const added = threads.length - (previous?.n ?? 0);
  if (threadHash !== previous?.u && (threads.length || previous?.n))
    news.push(
      added > 0
        ? `${added} new unresolved threads`
        : "unresolved threads changed",
    );
  if (state !== previous?.v && !news.length) news.push("state changed");
  let time = previous?.t ?? "",
    ids = [...(previous?.i ?? [])];
  for (const item of remarks) {
    if (item.time > time) {
      time = item.time;
      ids = [];
    }
    if (item.time === time && !ids.includes(item.id)) ids.push(item.id);
  }
  const next = watchToken(
    JSON.stringify({
      r: hash(pr.url),
      h: current.headRefOid,
      f: raced
        ? (remembered?.f ?? [])
        : checks.length
          ? failed.map((check) => check.name)
          : (old?.f ?? []),
      p: !!remembered?.p || (!raced && passed),
      t: raced ? (previous?.t ?? "") : time,
      i: raced ? (previous?.i ?? []) : ids,
      c: raced ? !!remembered?.c : conflicting,
      u: raced ? (previous?.u ?? "") : threadHash,
      n: raced ? (previous?.n ?? 0) : threads.length,
      v: raced ? "" : state,
    }),
  );
  if (input.since && !raced && !news.length) return null;
  return {
    pr: input.pr,
    head: current.headRefOid,
    verdict: raced ? "waiting" : verdict,
    reasons: raced ? [] : reasons,
    news: raced ? [moved ? "head moved" : "state changed"] : news,
    end: !raced && (verdict === "ready" || verdict === "gone"),
    next,
  };
}

type Call<T> = import("../../contract/author.ts").HandlerCall<T> & {
  readonly config: CheckConfig;
  readonly services: CatalogServices;
};
const operations = {
  "pr.state": prState,
  "pr.merge": prMerge,
  async "check.gate"(args: Call<GateInput>) {
    return await gate(gateServices(args), args.input, args.config, {
      signal: args.signal,
      deadline: args.deadline,
    });
  },
  async "check.run"(args: Call<RunInput>) {
    validateBudgets(selectedConfig(args.config, args.input.checks).config);
    const services = args.services;
    const config = args.config;
    const engine = createCheck({
      process: services.process,
      state: services.state,
      output: services.output,
      crypto: services.crypto,
      root: services.files.root,
      environment: services.environment.select(config.environment),
      clock: { now: () => Date.now() },
      snapshot: () =>
        services.files.snapshot({
          paths: config.inputs,
          maxBytes: config.maxInputBytes,
          timeoutMs: Math.max(1, args.deadline - Date.now()),
          maxOutputBytes: SNAPSHOT_HEAD_OUTPUT_BYTES,
        }),
    });
    return await engine.run(args.input, config, {
      signal: args.signal,
      deadline: args.deadline,
    });
  },
  "check.list"(args: Call<Readonly<Record<string, never>>>) {
    return {
      commands: Object.keys(args.config.commands),
      receiptChecks: args.config.gate?.receiptChecks ?? [],
    };
  },
  "check.show"(args: Call<{ readonly id: string }>) {
    const record = args.services.state.get(`runs/${args.input.id}`);
    if (!record) return null;
    const value = record.value;
    if (
      !isRecord(value) ||
      typeof value.inputsDigest !== "string" ||
      !verify(value, value.inputsDigest, args.services.crypto)
    )
      failure("INPUT_CONFLICT", "Check receipt integrity failed");
    return value;
  },
};
module.exports = {
  ...operations,
  createCheck,
  commandArguments,
  canonical,
  digest,
  verify,
  validateBudgets,
  runTimeoutMs,
  finalizationTimeoutMs,
};
