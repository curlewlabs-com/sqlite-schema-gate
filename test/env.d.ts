// The bindings vitest.config.ts gives the test runtime.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
