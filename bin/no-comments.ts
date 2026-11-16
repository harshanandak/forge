import { main } from "../tools/checks/no-comments.ts";
export { main };
export { default } from "../tools/lint/no-comments.ts";
if (import.meta.main) main();
