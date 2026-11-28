export interface SkillResourceFile {
  readonly noun: string;
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface SkillResourceProvider {
  catalog(): Promise<ReadonlyMap<string, SkillResourceFile>>;
}
