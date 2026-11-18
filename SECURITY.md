# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it
privately via
[GitHub's security advisory feature](https://github.com/curlewlabs-com/sqlite-schema-gate/security/advisories/new).

Do not open a public issue for security vulnerabilities.

## Scope

This is test-time and CI tooling, and it has no runtime dependencies.

- **SQL it runs.** `readSchema` runs only `SELECT`s over SQLite's pragma
  table-valued functions and `sqlite_master`. Table and index names, which come
  from the database's own catalog, are quoted into those statements as SQL
  literals with any embedded quote doubled. Nothing else is executed.
- **SQL it reads.** The migration lint and the seed fence read SQL text and
  never execute it. They are checks, not sandboxes: a migration or seed file
  that passes is still run by whatever applies it, with that tool's
  privileges.
- **What a pass means.** Each check reports only the hazards its README section
  names. A file it passes can still be wrong in ways it does not read; the
  README's "Limits" and "Known issues" list the known ones.
