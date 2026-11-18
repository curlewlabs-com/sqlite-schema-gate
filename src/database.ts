// The database surface the schema reader calls through: the subset of
// Cloudflare D1's binding API it uses. `env.DB` in the Workers test runtime
// satisfies it structurally, so no adapter sits between a test and D1's own
// engine.

export interface SchemaStatement {
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface SchemaDatabase {
  prepare(sql: string): SchemaStatement;
  batch<T = Record<string, unknown>>(
    statements: SchemaStatement[],
  ): Promise<{ results: T[] }[]>;
}
