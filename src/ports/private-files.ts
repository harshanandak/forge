/** Native security boundary; descriptor strings use Windows SDDL. */
export interface PrivateFiles {
  readonly sid: string;
  read(path: string): string;
  protect(path: string, descriptor: string): void;
}
