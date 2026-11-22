export const SESSION_AGE = 900;
const noStore = {
  "Cache-Control": "private, no-store",
  "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
};
type Fields = Record<string, string>;
export function appReply(code: number, fields?: Fields, body?: string) {
  const headers = { ...fields, ...noStore };
  return new Response(body, { status: code, headers });
}
export function reportPage(signedIn: boolean) {
  const control = signedIn
    ? '<form method="post" action="/app/logout"><button>Sign out</button></form>'
    : '<a href="/app/sign-in">Sign in</a>';
  const head = '<!doctype html><html lang="en"><title>Forge</title>';
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self'; script-src 'self'; manifest-src 'self'; img-src 'self'",
  };
  return appReply(200, headers, head + control + "</html>");
}
export const appUnavailable = () => appReply(503);
