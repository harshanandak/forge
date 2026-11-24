import { protectionFixture } from "./protect-fixture.ts";

export function schemaFixture() {
  const { temp, cleanup } = protectionFixture();
  const handles = new Set<{ close(): void }>();
  function close(db: { close(): void }): void {
    handles.delete(db);
    db.close();
  }
  return {
    temp,
    close,
    track<T extends { close(): void }>(this: void, db: T): T {
      handles.add(db);
      return db;
    },
    cleanup(this: void) {
      for (const db of handles) close(db);
      cleanup();
    },
  };
}
