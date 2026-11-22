import type { TrackerItem } from "../../src/generated/types.ts";
import { appReply, reportPage } from "./report-http.ts";
import { icon192, icon512 } from "./report-icons.ts";

export const REPORT_ROUTE = "/__forge/report";
export const REPORT_UNTIL = "X-Forge-Report-Until";
export const validIssue = (id: string) =>
  id.length <= 200 && /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/i.test(id);

const head =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/app/manifest.webmanifest"><link rel="apple-touch-icon" href="/app/icon-192.png"><link rel="stylesheet" href="/app/report.css"><script src="/app/report.js" defer></script>';
const form =
  '<form method="get" action="/app/"><label>Issue ID <input name="issue" maxlength="200" required></label><button>Read issue</button></form>';
const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

type Login = { issue?: string };
export async function appPage(signedIn: boolean, body = "", login?: Login) {
  const page = reportPage(signedIn);
  const issue = login?.issue;
  const query = issue ? `?${new URLSearchParams({ issue })}` : "";
  const html = (await page.text())
    .replace("<title>", head + "<title>")
    .replace('href="/app/sign-in"', `href="/app/sign-in${escape(query)}"`)
    .replace("</html>", () => form + body + "</html>");
  const status = login ? 401 : 200;
  return new Response(html, { status, headers: page.headers });
}

export function renderIssue({ id, title, status, body = "" }: TrackerItem) {
  const clipped = body.length > 8_000 ? "<p>Issue body clipped.</p>" : "";
  return appPage(
    true,
    `<article><h1>${escape(title)}</h1><p>${escape(id)} · ${escape(status)}</p><pre>${escape(body.slice(0, 8_000))}</pre>${clipped}</article>`,
  );
}

export function reportRequest(issue: string, until: number) {
  const query = new URLSearchParams({ issue });
  return new Request(`https://project.internal${REPORT_ROUTE}?${query}`, {
    headers: { [REPORT_UNTIL]: String(until) },
  });
}

const manifest = JSON.stringify({
  name: "Forge",
  short_name: "Forge",
  id: "/app/",
  start_url: "/app/",
  scope: "/app/",
  display: "standalone",
  icons: [192, 512].map((size) => ({
    src: `/app/icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: "image/png",
  })),
});
const css = `body { margin: 1rem auto; max-width: 48rem; padding: 0 1rem; font: 1rem/1.5 system-ui; }
form { margin: 1rem 0; }
input, button { font: inherit; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }`;
const js = `addEventListener("pagehide", () => document.querySelector("article")?.replaceChildren());
addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });`;
type Asset = readonly [mime: string, body: string | Uint8Array<ArrayBuffer>];
const assets: Readonly<Record<string, Asset>> = {
  "/app/manifest.webmanifest": ["application/manifest+json", manifest],
  "/app/report.css": ["text/css; charset=utf-8", css],
  "/app/report.js": ["text/javascript; charset=utf-8", js],
  "/app/icon-192.png": ["image/png", Buffer.from(icon192, "base64")],
  "/app/icon-512.png": ["image/png", Buffer.from(icon512, "base64")],
};

export function appAsset(path: string, method: string) {
  const asset = assets[path];
  if (!asset) return;
  if (method !== "GET") return appReply(405, { Allow: "GET" });
  const [type, body] = asset;
  const { headers } = appReply(200, { "Content-Type": type });
  return new Response(body, { headers });
}
