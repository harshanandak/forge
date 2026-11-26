export function hasDeviceCredential(value: string): boolean {
  return /fct_/i.test(value);
}
