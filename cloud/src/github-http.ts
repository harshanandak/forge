import { createGithubJsonBudget, parseGithubJson } from "./github-json.ts";
import { isPlainJson } from "./plain-json.ts";
type Query = Readonly<Record<string, string>>;
type Get = (path: readonly string[], query?: Query) => Promise<unknown>;
type Collect = (
  path: readonly string[],
  query?: Query,
  key?: string,
) => Promise<unknown[]>;
type Ports = {
  fetch(url: string, init: RequestInit): Promise<Response>;
  credential(
    id: number,
    signal: AbortSignal,
  ): Promise<{ token: string; expiresAt: number } | null>;
  now(): number;
  deadline(expire: () => void, ms: number): () => void;
  signal: AbortSignal;
};
type Refusal = {
  ok: false;
  code: "INPUT_INVALID" | "UNAVAILABLE";
  reason: string;
};
const ORIGIN = "https://api.github.com",
  REQUESTS = 32,
  PAGES = 3,
  PAGE_SIZE = 100,
  DEADLINE = 10_000;
export async function withGithubHttp<T>(
  locator: unknown,
  ports: Ports,
  read: (session: { get: Get; collect: Collect }) => Promise<T>,
): Promise<{ ok: true; value: T } | Refusal> {
  const controller = new AbortController(),
    budget = createGithubJsonBudget();
  let refusal: Refusal["code"] | undefined,
    clear = () => {},
    requests = 0,
    active = 0;
  function fail(code: Refusal["code"] = "UNAVAILABLE"): never {
    refusal ??= code;
    controller.abort();
    throw new Error("GitHub unavailable");
  }
  const abort = () => controller.abort();
  try {
    if (
      !isPlainJson(locator) ||
      typeof locator !== "object" ||
      locator === null ||
      Array.isArray(locator)
    )
      fail("INPUT_INVALID");
    const l = locator as Record<string, unknown>;
    if (
      Object.keys(l).length !== 5 ||
      typeof l.owner !== "string" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(l.owner) ||
      typeof l.repo !== "string" ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(l.repo) ||
      /^\.{1,2}$/.test(l.repo) ||
      !positive(l.repositoryId) ||
      !positive(l.prNumber) ||
      typeof l.branch !== "string" ||
      !l.branch ||
      l.branch.length > 256 ||
      /[\s\p{Cc}~^:?*[\\]|\.\.|@\{|^\/|\/$|\/\/|\.$|\.lock(?:\/|$)|(?:^|\/)\./u.test(
        l.branch,
      ) ||
      l.branch === "@"
    )
      fail("INPUT_INVALID");
    const root = `${ORIGIN}/repos/${encodeURIComponent(l.owner)}/${encodeURIComponent(l.repo)}/`;
    if (ports.signal.aborted) fail();
    const start = ports.now();
    const expired = () =>
      controller.signal.aborted || ports.now() - start >= DEADLINE;
    const check = () => {
      if (expired()) fail();
    };
    const interrupted = new Promise<null>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(null), {
        once: true,
      });
    });
    ports.signal.addEventListener("abort", abort, { once: true });
    clear = ports.deadline(abort, DEADLINE);
    const work = async () => {
      check();
      const credential = await ports.credential(
        l.repositoryId as number,
        controller.signal,
      );
      check();
      if (
        !credential ||
        typeof credential.token !== "string" ||
        !credential.token ||
        !Number.isFinite(credential.expiresAt)
      )
        fail();
      const get: Get = async (path, query = {}) => {
        active++;
        try {
          check();
          if (++requests > REQUESTS || credential.expiresAt <= ports.now())
            fail();
          if (
            !isPlainJson([path, query]) ||
            !path.length ||
            path.some(
              (p) =>
                typeof p !== "string" || !/^(?!\.{1,2}$)[\s\S]{1,256}$/.test(p),
            ) ||
            Object.values(query).some(
              (v) => typeof v !== "string" || v.length > 256,
            )
          )
            fail("INPUT_INVALID");
          const url = new URL(
            `${root}${path.map(encodeURIComponent).join("/")}`,
          );
          for (const [key, value] of Object.entries(query))
            url.searchParams.set(key, value);
          const response = await ports.fetch(url.href, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${credential.token}`,
              Accept: "application/vnd.github+json",
            },
          });
          if (
            expired() ||
            response.status < 200 ||
            response.status >= 300 ||
            response.redirected ||
            (response.url && new URL(response.url).origin !== ORIGIN) ||
            response.headers.get("X-RateLimit-Remaining") === "0"
          ) {
            void response.body?.cancel().catch(() => {});
            fail();
          }
          const parsed = await parseGithubJson(
            response,
            budget,
            controller.signal,
          );
          check();
          if (!parsed.ok) fail(parsed.code);
          return parsed.value;
        } catch {
          return fail();
        } finally {
          active--;
        }
      };
      const collect: Collect = async (path, query = {}, key) => {
        active++;
        try {
          check();
          if (
            !isPlainJson([path, query]) ||
            Object.hasOwn(query, "page") ||
            Object.hasOwn(query, "per_page")
          )
            fail("INPUT_INVALID");
          // Snapshot server-owned filters before the first await; never follow Link.
          const fixedPath = [...path],
            fixedQuery = { ...query };
          const rows: unknown[] = [];
          let total: number | undefined;
          for (let page = 1; page <= PAGES; page++) {
            const value = await get(fixedPath, {
              ...fixedQuery,
              page: String(page),
              per_page: String(PAGE_SIZE),
            });
            let batch = value;
            if (key !== undefined) {
              if (!value || typeof value !== "object" || Array.isArray(value))
                fail();
              const envelope = value as Record<string, unknown>;
              if (
                Object.hasOwn(envelope, "incomplete_results") &&
                envelope.incomplete_results !== false
              )
                fail();
              const count = envelope.total_count;
              if (
                typeof count !== "number" ||
                !Number.isSafeInteger(count) ||
                count < 0 ||
                (total !== undefined && total !== count)
              )
                fail();
              total = count;
              batch = envelope[key];
            }
            if (!Array.isArray(batch) || batch.length > PAGE_SIZE) fail();
            const items: unknown[] = batch;
            rows.push(...items);
            if (
              total !== undefined &&
              (rows.length > total ||
                (batch.length < PAGE_SIZE && rows.length !== total))
            )
              fail();
            if (rows.length === total || batch.length < PAGE_SIZE) return rows;
          }
          return fail();
        } catch {
          return fail();
        } finally {
          active--;
        }
      };
      const value = await read({ get, collect });
      check();
      if (active) fail();
      return { ok: true as const, value };
    };
    return (await Promise.race([work(), interrupted])) ?? fail();
  } catch {
    return {
      ok: false,
      code: refusal ?? "UNAVAILABLE",
      reason:
        refusal === "INPUT_INVALID"
          ? "Invalid GitHub request"
          : "GitHub unavailable",
    };
  } finally {
    ports.signal.removeEventListener("abort", abort);
    controller.abort();
    try {
      clear();
    } catch {
      /* Cleanup must not expose injected errors. */
    }
  }
}
function positive(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}
