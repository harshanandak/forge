export interface DirectoryMigration {
  readonly version: number;
  readonly tables: readonly {
    readonly name: string;
    readonly columns: readonly string[];
    readonly unique: readonly (readonly string[])[];
  }[];
}

export const migrations: readonly DirectoryMigration[] = [];
