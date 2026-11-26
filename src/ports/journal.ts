export interface JournalFileSecurity {
  directory(path: string, created: boolean): void;
  file(path: string): void;
}

export interface JournalAppendPolicy {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

export interface JournalReadResult {
  readonly lines: readonly string[];
  readonly incomplete: boolean;
}

export interface Journal {
  append(this: void, line: string, policy?: JournalAppendPolicy): void;
  read(this: void): JournalReadResult;
}
