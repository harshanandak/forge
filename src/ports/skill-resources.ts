export interface SkillResourceFile {
  readonly noun: string;
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface SkillManifestFile {
  readonly uri: string;
  readonly digest: string;
  readonly size: number;
}

export interface SkillManifest {
  readonly uri: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly resources: readonly SkillManifestFile[];
}

export interface SkillResourceProvider {
  catalog(): Promise<ReadonlyMap<string, SkillResourceFile>>;
  manifests(): Promise<ReadonlyMap<string, SkillManifest>>;
}
