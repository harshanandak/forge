/** The project name a route may carry, unanchored and capture-free so each caller anchors it. */
export const PROJECT_NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";

/** A complete match only: `$` alone would also accept a final newline, so the whole value must match. */
export const isProjectName = (value: unknown): value is string =>
  typeof value === "string" &&
  new RegExp(`^${PROJECT_NAME}$`).exec(value)?.[0] === value;
