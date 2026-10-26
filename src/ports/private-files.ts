/** Native security boundary; descriptor strings use Windows SDDL. */
export interface PrivateFiles {
  readonly sid: string;
  /** Aliases natively verified to identify sid. */
  readonly aliases?: readonly string[];
  /** Raw Windows owner SID, without SDDL aliases. */
  owner(path: string): string;
  read(path: string): string;
  protect(path: string, descriptor: string): void;
}
