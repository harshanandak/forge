export interface WindowsSecurityReader {
  user(): Buffer;
  read(path: string, directory: boolean): Buffer;
}
