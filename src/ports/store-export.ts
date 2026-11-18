export interface StoreExportResult {
  readonly out: string;
  readonly sha256: string;
  readonly eventHighWaterMark: number;
  readonly records: number;
}

export interface StoreExport {
  export(input: unknown): StoreExportResult;
}
