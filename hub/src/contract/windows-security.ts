export interface WindowsSecurityReader {
  user(): Buffer;
  read(path: string, directory: boolean): Buffer;
}

export interface WindowsDirectoryCreator extends WindowsSecurityReader {
  isDirectory(path: string): boolean;
  createDirectory(path: string, descriptor: Buffer): boolean;
  move(source: string, target: string): boolean;
  removeDirectory(path: string): boolean;
}
