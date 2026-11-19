/** What a finished login reports. It never holds the token. */
export interface CloudLoginResult {
  readonly origin: string;
  readonly project: string;
  readonly device: string;
  readonly session?: string;
  readonly tokenId: string;
  readonly expiresAt: string;
  readonly binding: "created" | "unchanged";
}
export interface CloudLogoutResult {
  readonly status: "logged-out" | "not-bound";
  readonly origin?: string;
  readonly project?: string;
  readonly tokenId?: string;
  readonly tokenRevoked: false;
}
/** Log this device in to one Forge cloud project and keep the credential private. */
export interface CloudLogin {
  login(input: unknown): Promise<CloudLoginResult>;
  logout(input: unknown): Promise<CloudLogoutResult>;
}
