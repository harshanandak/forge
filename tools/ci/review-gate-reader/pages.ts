import { fail, ok } from "./result.ts";
import * as json from "./strict-json.ts";
import { getResponse, type Transport } from "./transport.ts";

export const numericId = "id";
export const fileName = "filename";
type Identity = typeof numericId | typeof fileName;

function nextPath(link: string | undefined, origin: string) {
  if (link === undefined) return undefined;
  let next: string | undefined;
  for (const part of link.split(/,(?=[ \t]*<)/)) {
    const [, target, rel] =
      /^[ \t]*<([^<>\s]+)>[ \t]*;[ \t]*rel="([a-z]+)"[ \t]*$/.exec(part) ?? [];
    const url = target && URL.parse(target);
    if (!url || !rel || url.username || url.password || url.hash) return false;
    if (rel !== "next") continue;
    const path = url.pathname;
    const absolutePath = path.startsWith("/") && !path.startsWith("//");
    if (next || url.origin !== origin || !absolutePath) return false;
    next = path + url.search;
  }
  return next;
}

export async function readPages<
  K extends Identity,
  S extends json.Fields &
    Record<K, json.Predicate<K extends "id" ? number : string>>,
>(transport: Transport, first: string, item: S, identity: K) {
  const items: json.Value<S>[] = [];
  const visited = new Set<string>();
  const identities = new Set<unknown>();
  for (let path = first; visited.size < 100 && !visited.has(path);) {
    visited.add(path);
    const response = await getResponse(transport, path);
    if (!response.ok) return response;
    const { body, headers } = response.value;
    const page = json.parseStrictJson(body, json.list(item), `${path}#`);
    if (!page.ok) return page;
    for (const [index, entry] of page.value.entries()) {
      const key = (entry as Record<string, unknown>)[identity];
      if (key === "")
        return fail("api_field_invalid", `${path}#$[${index}].${identity}`);
      if (identities.has(key)) return fail("pages_incomplete", first);
      identities.add(key);
      items.push(entry);
    }
    const next = nextPath(headers.link, transport.origin);
    if (next === undefined) return ok(items);
    if (next === false) break;
    path = next;
  }
  return fail("pages_incomplete", first);
}
