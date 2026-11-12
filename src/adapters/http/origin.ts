// The two cloud names a project may bind. They live apart from the transport so reading a
// binding does not load node:https.
import { ForgeFailure } from "../../contract/failure.ts";

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const invalid = (message: string): ForgeFailure =>
  new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });

/** An HTTPS origin and nothing else: no credentials, path, query or fragment, and already canonical. */
export function validateOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw invalid("origin must be an HTTPS origin such as https://host");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== origin
  )
    throw invalid(
      "origin must be an HTTPS origin with no credentials, path, query or fragment",
    );
  return origin;
}

/** The Worker's route grammar for a project name. */
export function validateProject(project: string): string {
  if (!PROJECT.test(project))
    throw invalid(
      "project must be 1 to 64 letters, digits, dots, hyphens or underscores, starting with a letter or digit",
    );
  return project;
}
