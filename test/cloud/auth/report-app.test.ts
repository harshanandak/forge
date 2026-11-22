import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { browserStorage } from "../browser-storage.fixture.ts";
import {
  active,
  callback,
  Jar,
  noStore,
  origin,
  reportFixture,
  reportPath,
  session,
} from "./report-fixture.ts";

const { Project } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const reportTest = (name: string, check: () => Promise<void>) =>
  test(name, check, 15_000);
const logout = { method: "POST", headers: { Origin: origin } };
const untilHeader = "X-Forge-Report-Until";
const title = "Report <script>\"title\"</script> & 'quote'";
const escapedTitle =
  "Report &lt;script&gt;&quot;title&quot;&lt;/script&gt; &amp; &#39;quote&#39;";
const body =
  "<script>'body'</script>\nline " + "x".repeat(8_000) + "clipped tail";
const issue = "/app/?issue=fixture-1";
const missing = "/app/?issue=fixture-999";
const marker = "report-session";

afterEach(() => mock.restore());

function fixture() {
  const f = reportFixture();
  spyOn(Date, "now").mockImplementation(f.clock.now);
  return f;
}

function projectBinding(
  db: Database,
  afterRead?: (reply: Response) => void | Promise<void>,
) {
  const writes: string[] = [];
  const reads: Request[] = [];
  const { storage } = browserStorage(db, (sql) => {
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes.push(sql);
  });
  const project = new Project(
    { storage },
    { FORGE_CLOUD_PROJECT: "p", FORGE_CLOUD_ID_PREFIX: "fixture" },
  );
  const PROJECTS = {
    idFromName: String,
    get(name: string) {
      expect(name).toBe("p");
      return {
        async fetch(request: Request) {
          const reply = await project.fetch(request);
          if (new URL(request.url).pathname === "/__forge/report") {
            reads.push(request);
            await afterRead?.(reply);
          }
          return reply;
        },
      };
    },
  };
  return { writes, reads, PROJECTS, project };
}

async function seed(
  f: ReturnType<typeof fixture>,
  PROJECTS: ReturnType<typeof projectBinding>["PROJECTS"],
) {
  const device = await f.send(
    "/p/p/devices",
    new Jar(),
    {
      method: "POST",
      headers: { Authorization: "Bearer fixture-admin" },
      body: JSON.stringify({ device: "fixture", ttlMs: 60_000 }),
    },
    { PROJECTS },
  );
  expect(device.status).toBe(200);
  const { value } = (await device.json()) as { value: { token: string } };
  const created = await f.send(
    "/p/p/command",
    new Jar(),
    {
      method: "POST",
      headers: { Authorization: "Bearer " + value.token },
      body: JSON.stringify({
        op: "issue.create",
        requestId: "seed-report",
        context: { actor: { kind: "agent", id: "fixture" } },
        input: { title, body },
      }),
    },
    { PROJECTS },
  );
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({
    ok: true,
    result: { id: "fixture-1" },
  });
}

async function checked(reply: Promise<Response>, status: number) {
  const response = await reply;
  expect(response.status).toBe(status);
  noStore(response);
  return response;
}

const signInLink = /href="([^"]+)">Sign in<\/a>/;

async function followSignIn(
  f: ReturnType<typeof fixture>,
  jar: Jar,
  href: string,
) {
  const start = await checked(f.send(href, jar), 302);
  const clerk = new URL(start.headers.get("Location")!);
  return checked(f.send(callback(clerk.searchParams.get("state")!), jar), 303);
}

reportTest("shared report link survives sign-in", async () => {
  const f = fixture();
  const jar = new Jar();
  using db = new Database(":memory:");
  const { PROJECTS } = projectBinding(db);
  await seed(f, PROJECTS);
  const lookups = spyOn(PROJECTS, "get");
  const page = await checked(f.send(issue, jar, {}, { PROJECTS }), 401);
  const href = signInLink.exec(await page.text())?.[1];
  expect(href).toBe("/app/sign-in?issue=fixture-1");
  const signedIn = await followSignIn(f, jar, href!);
  const destination = signedIn.headers.get("Location");
  expect(destination).toBe(issue);
  expect(lookups).not.toHaveBeenCalled();
  const reply = await checked(f.send(destination!, jar, {}, { PROJECTS }), 200);
  expect(await reply.text()).toContain(escapedTitle);
});

reportTest("bad report ids stay out of sign-in and its redirect", async () => {
  const f = fixture();
  for (const query of [
    "fixture-1%22%3E",
    "p".repeat(199) + "-1",
    "fixture-1&issue=fixture-2",
  ]) {
    const jar = new Jar();
    const page = await checked(f.send("/app/?issue=" + query, jar), 401);
    const href = signInLink.exec(await page.text())?.[1];
    expect(href).toBe("/app/sign-in");
    const signedIn = await followSignIn(f, jar, href!);
    expect(signedIn.headers.get("Location")).toBe("/app/");
  }
  expect(f.trace.projects).toEqual([]);
});

reportTest("report requires owner", async () => {
  const f = fixture();
  const anonymous = await f.send(issue);
  expect(anonymous.status).toBe(401);
  noStore(anonymous);
  const generic = (await anonymous.text()).replace(signInLink, "Sign in");
  expect(generic).toContain("Sign in");
  expect(generic).not.toContain("fixture-1");
  const missingPage = await checked(f.send(missing), 401);
  expect((await missingPage.text()).replace(signInLink, "Sign in")).toBe(
    generic,
  );
  expect(f.trace.projects).toEqual([]);

  const jar = new Jar();
  const { record } = await session(f, jar);
  const forged = new Jar([[active, jar.get(active)! + "x"]]);
  await checked(f.send(issue, forged), 401);
  for (const overrides of [
    { FORGE_OWNER_SUBJECT: "user_Other2" },
    { FORGE_CLOUD_PROJECT: "other" },
  ])
    await checked(f.send(issue, jar, {}, overrides), 401);
  record.values.set(marker, Infinity);
  await checked(f.send(issue, jar), 401);
  record.values.delete(marker);
  await checked(f.send(issue, jar), 401);
  expect(f.trace.projects).toEqual([]);
});

reportTest("report renders escaped owner data", async () => {
  const f = fixture();
  const jar = new Jar();
  const { record } = await session(f, jar);
  using db = new Database(":memory:");
  let internal: Response | undefined;
  const binding = projectBinding(db, (reply) => {
    internal = reply;
  });
  const { PROJECTS, reads, writes } = binding;
  await seed(f, PROJECTS);
  const writeCount = writes.length;
  const reply = await f.send(
    issue,
    jar,
    {
      headers: {
        [untilHeader]: "1",
        Authorization: "Bearer browser",
        "X-Browser": "private",
      },
    },
    { PROJECTS },
  );
  const html = await reply.text();
  expect(html).toContain(escapedTitle);
  expect(reply.status).toBe(200);
  noStore(reply);
  noStore(internal!);
  expect(reply.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(reply.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self'; script-src 'self'; manifest-src 'self'; img-src 'self'",
  );
  expect(reply.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(reply.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(reply.headers.get("X-Frame-Options")).toBe("DENY");
  expect(html).toContain("fixture-1");
  expect(html).toContain("open");
  expect(html).toContain("&lt;script&gt;&#39;body&#39;&lt;/script&gt;\nline");
  expect(html).toContain("clipped");
  expect(html).not.toContain("clipped tail");
  expect(html).not.toContain("<script>");
  expect([...reply.headers.values()].join("\n")).not.toContain("Report");
  expect(reads).toHaveLength(1);
  const request = reads[0]!;
  const url = new URL(request.url);
  expect(url.pathname + url.search).toBe("/__forge/report?issue=fixture-1");
  expect([...request.headers]).toEqual([
    [untilHeader.toLowerCase(), String(record.values.get(marker))],
  ]);
  expect(request.url).not.toContain(jar.get(active)!);
  await checked(f.send(issue, new Jar(), {}, { PROJECTS }), 401);
  expect(reads).toHaveLength(1);
  await checked(f.send(missing, jar, {}, { PROJECTS }), 404);
  const wrongMethod = await checked(
    f.send(issue, jar, { method: "POST" }, { PROJECTS }),
    405,
  );
  expect(wrongMethod.headers.get("Allow")).toBe("GET");
  expect(writes).toHaveLength(writeCount);
});

reportTest("report install assets stay public and inert", async () => {
  const f = fixture();
  const jar = new Jar();
  const manifest = await f.send("/app/manifest.webmanifest", jar);
  expect(manifest.status).toBe(200);
  expect(manifest.headers.get("Content-Type")).toBe(
    "application/manifest+json",
  );
  noStore(manifest);
  const icons = [192, 512].map((size) => ({
    src: "/app/icon-" + size + ".png",
    sizes: size + "x" + size,
    type: "image/png",
  }));
  expect(await manifest.json()).toEqual({
    name: "Forge",
    short_name: "Forge",
    id: "/app/",
    start_url: "/app/",
    scope: "/app/",
    display: "standalone",
    icons,
  });
  for (const [index, icon] of icons.entries()) {
    const png = await checked(f.send(icon.src, jar), 200);
    expect(png.headers.get("Content-Type")).toBe("image/png");
    const data = Buffer.from(await png.arrayBuffer());
    expect(data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const size = index === 0 ? 192 : 512;
    expect([data.readUInt32BE(16), data.readUInt32BE(20)]).toEqual([
      size,
      size,
    ]);
    expect(png.headers.getSetCookie()).toEqual([]);
  }
  for (const [path, mime] of [
    ["report.css", "css"],
    ["report.js", "javascript"],
  ]) {
    const asset = await checked(f.send("/app/" + path, jar), 200);
    expect(asset.headers.get("Content-Type")).toBe(
      "text/" + mime + "; charset=utf-8",
    );
    const content = await asset.text();
    expect(content).not.toContain(title);
    expect(content).not.toContain("serviceWorker");
    if (mime === "javascript") {
      expect(content).toContain("pagehide");
      expect(content).toContain("pageshow");
      expect(content).toContain("persisted");
    }
    expect(asset.headers.getSetCookie()).toEqual([]);
  }
  for (const path of ["sw.js", "unknown"])
    await checked(f.send("/app/" + path, jar), 404);
  expect(manifest.headers.getSetCookie()).toEqual([]);
  expect(jar.size).toBe(0);
  expect(f.trace.durable).toEqual([]);
  const page = await checked(f.send("/app/", jar), 200);
  const html = await page.text();
  expect(html).toContain('href="/app/manifest.webmanifest"');
  expect(html).toContain('href="/app/icon-192.png"');
  expect(html).toContain('name="issue"');
  expect(html).toContain("Sign in");
  expect(f.trace.projects).toEqual([]);
  expect(f.trace.writes).toEqual([]);
});

reportTest(
  "report rejects bad issue parameters and keeps private paths internal",
  async () => {
    const f = fixture();
    const jar = new Jar();
    await session(f, jar);
    for (const query of [
      "issue=",
      "issue=a",
      "issue=" + "p".repeat(199) + "-1",
      "issue=p-1&issue=p-2",
    ])
      await checked(f.send("/app/?" + query, jar), 400);
    for (const path of ["/__forge/report?issue=fixture-1", reportPath])
      expect(
        (
          await f.send(path, jar, {
            headers: { [untilHeader]: String(f.clock.now() + 1000) },
          })
        ).status,
      ).toBe(404);
    expect(f.trace.projects).toEqual([]);
  },
);

reportTest(
  "Project refuses unprovisioned and expired report reads",
  async () => {
    const f = fixture();
    using db = new Database(":memory:");
    const { PROJECTS, project } = projectBinding(db);
    const read = (until: number) =>
      project.fetch(
        new Request("https://project.internal/__forge/report?issue=fixture-1", {
          headers: { [untilHeader]: String(until) },
        }),
      );
    const unprovisioned = await read(f.clock.now() + 1_000);
    expect(unprovisioned.ok).toBe(false);
    noStore(unprovisioned);
    await seed(f, PROJECTS);
    const expired = await read(f.clock.now());
    expect(expired.ok).toBe(false);
    noStore(expired);
    expect(await expired.text()).not.toContain(title);
  },
);

reportTest(
  "report revokes copied cookies after logout or expiry, even mid-fetch",
  async () => {
    for (const end of ["logout", "expiry"]) {
      const f = fixture();
      const jar = new Jar();
      const { record } = await session(f, jar);
      const copy = new Jar(jar);
      const arrived = Promise.withResolvers<string>();
      const resume = Promise.withResolvers<void>();
      using db = new Database(":memory:");
      let paused = false;
      const { PROJECTS, reads } = projectBinding(db, async (response) => {
        if (paused) {
          arrived.resolve(await response.clone().text());
          await resume.promise;
        }
      });
      await seed(f, PROJECTS);
      const read = () => f.send(issue, copy, {}, { PROJECTS });
      await checked(f.send(issue, jar, {}, { PROJECTS }), 200);
      await checked(read(), 200);
      paused = true;
      const pending = read();
      try {
        const result = await Promise.race([
          arrived.promise,
          pending.then(({ status }) => status),
        ]);
        expect(typeof result).toBe("string");
        expect(result as string).toContain(escapedTitle);
        if (end === "logout")
          await checked(f.send("/app/logout", jar, logout), 303);
        else f.advance(record.values.get(marker)! - f.clock.now());
      } finally {
        resume.resolve();
      }
      const refused = await checked(pending, 401);
      expect(await refused.text()).not.toContain(escapedTitle);
      await checked(read(), 401);
      expect(reads).toHaveLength(3);
    }
  },
);
