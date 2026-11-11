/** What a finished login reports. It never holds the token. */
export interface CloudLoginResult {
  readonly origin: string;
  readonly project: string;
  readonly device: string;
  readonly tokenId: string;
  readonly expiresAt: string;
  readonly binding: "created" | "unchanged";
}
/** Log this device in to one Forge cloud project and keep the credential private. */
export interface CloudLogin {
  login(input: unknown): Promise<CloudLoginResult>;
}
