/**
 * Ambient declaration for Bun's built-in SQLite module.
 * Only the tiny surface the usage reader needs is described; the runtime
 * import in limits.ts is dynamic and fully guarded, so this file only has to
 * keep `tsc` happy on hosts without Bun types installed.
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean });
    prepare(sql: string): {
      all(...args: unknown[]): unknown[];
      get(...args: unknown[]): unknown;
      run(...args: unknown[]): unknown;
    };
    close(): void;
  }
}
