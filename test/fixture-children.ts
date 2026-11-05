import type { ChildProcess } from "node:child_process";

/** Retain the children whose working directories and streams belong to a fixture. */
export class FixtureChildren {
  own<T extends ChildProcess>(child: T): T {
    return child;
  }

  async cleanup(remove: () => void): Promise<void> {
    remove();
  }
}
