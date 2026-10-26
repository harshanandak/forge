/** Persistent local holder identity; reads must never create filesystem entries. */
export interface DeviceIdentity {
  read(): string | undefined;
  acquire(): string;
}
