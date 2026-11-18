import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyAllowlist,
  lintSchemaLayout,
  readSchema,
  type AllowlistEntry,
  type LayoutRule,
} from "../src/index";

// Every case applies a schema to D1, reads it back through the pragmas, and
// lints what D1 reports, because the rules are only as right as the reader's
// idea of what SQLite says about a table.

async function dropUserTables(): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
     ORDER BY rowid DESC`,
  ).all<{ name: string }>();
  if (rows.results.length === 0) return;
  await env.DB.batch(
    rows.results.map((r) =>
      env.DB.prepare(`DROP TABLE "${r.name.replace(/"/g, '""')}"`),
    ),
  );
}

// The fixtures hold no `;` inside a literal, so a split on `;` is exact here.
async function applySchema(ddl: string): Promise<void> {
  const statements = ddl
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

async function findings(ddl: string, rule: LayoutRule) {
  await applySchema(ddl);
  return lintSchemaLayout(await readSchema(env.DB))
    .filter((f) => f.rule === rule)
    .map(({ table, column }) => (column ? `${table}.${column}` : table));
}

beforeEach(dropUserTables);

describe("readSchema", () => {
  // D1 keeps tables of its own beside the user's, and AUTOINCREMENT creates
  // sqlite_sequence; neither is the schema author's to change, so a rule that
  // read them would report what nobody can fix.
  it("reads user tables only", async () => {
    await applySchema(`
      CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
      CREATE TABLE books (id INTEGER PRIMARY KEY) STRICT
    `);
    const snapshot = await readSchema(env.DB);
    expect(snapshot.tables.map((t) => t.name)).toEqual(["authors", "books"]);
    expect([...snapshot.tableSql.keys()].sort()).toEqual(["authors", "books"]);
  });

  // Names are quoted into the pragma calls (D1 refuses a bound pragma argument
  // inside a batch), so a name holding a quote must not end the literal early.
  it("reads a table whose name holds a single quote", async () => {
    await applySchema(
      `CREATE TABLE "o'reilly" (id INTEGER PRIMARY KEY, title TEXT) STRICT`,
    );
    const snapshot = await readSchema(env.DB);
    expect(snapshot.columns.get("o'reilly")?.map((c) => c.name)).toEqual([
      "id",
      "title",
    ]);
  });

  it("reads foreign keys, indexes and their key columns", async () => {
    await applySchema(`
      CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        isbn TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE INDEX idx_books_author ON books(author_id, isbn)
    `);
    const snapshot = await readSchema(env.DB);
    expect(snapshot.foreignKeys.get("books")).toMatchObject([
      { table: "authors", from: "author_id", to: "id", on_delete: "CASCADE" },
    ]);
    const indexNames = snapshot.indexes.get("books")!.map((i) => i.name);
    expect(indexNames).toContain("idx_books_author");
    expect(
      snapshot.indexColumns.get("idx_books_author")!.map((c) => c.name),
    ).toEqual(["author_id", "isbn"]);
    expect(snapshot.indexSql.map((r) => r.name)).toContain("idx_books_author");
  });

  // The snapshot type promises `to` may be null; a caller reading it as a
  // string would typecheck and then fail on exactly this form.
  it("reports a key that names no parent column with a null `to`", async () => {
    await applySchema(`
      CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        author_id INTEGER REFERENCES authors ON DELETE CASCADE
      ) STRICT
    `);
    const snapshot = await readSchema(env.DB);
    expect(snapshot.foreignKeys.get("books")).toMatchObject([
      { table: "authors", from: "author_id", to: null },
    ]);
  });

  // An empty schema is a normal call, and D1 refuses an empty batch.
  it("reads a schema with no tables", async () => {
    const snapshot = await readSchema(env.DB);
    expect(snapshot.tables).toEqual([]);
  });
});

describe("strict-required", () => {
  it("fires on a table without STRICT, and not on one with it", async () => {
    expect(
      await findings(
        `CREATE TABLE loose (id INTEGER PRIMARY KEY);
         CREATE TABLE tight (id INTEGER PRIMARY KEY) STRICT`,
        "strict-required",
      ),
    ).toEqual(["loose"]);
  });
});

describe("blob-pk-or-unique-needs-check-length", () => {
  it("fires on a BLOB primary key or UNIQUE column with no length CHECK", async () => {
    expect(
      await findings(
        `CREATE TABLE share_links (slug BLOB PRIMARY KEY) STRICT;
         CREATE TABLE keys (id INTEGER PRIMARY KEY, fingerprint BLOB NOT NULL UNIQUE) STRICT`,
        "blob-pk-or-unique-needs-check-length",
      ),
    ).toEqual(["keys.fingerprint", "share_links.slug"]);
  });

  it("stays silent when the CHECK pins the length", async () => {
    expect(
      await findings(
        `CREATE TABLE share_links (
           slug BLOB PRIMARY KEY CHECK (length(slug) = 16)
         ) STRICT`,
        "blob-pk-or-unique-needs-check-length",
      ),
    ).toEqual([]);
  });

  // The parent's CHECK is the source of truth; a second copy on the child is
  // something to drift, so a BLOB that is a foreign key is exempt even when it
  // is also UNIQUE.
  it("exempts a BLOB that is a foreign key", async () => {
    expect(
      await findings(
        `CREATE TABLE share_links (slug BLOB PRIMARY KEY CHECK (length(slug) = 16)) STRICT;
         CREATE TABLE link_visits (
           id INTEGER PRIMARY KEY,
           slug BLOB NOT NULL UNIQUE REFERENCES share_links(slug) ON DELETE CASCADE
         ) STRICT`,
        "blob-pk-or-unique-needs-check-length",
      ),
    ).toEqual([]);
  });

  // A BLOB that is only one part of a compound UNIQUE is not a key on its own.
  it("ignores a BLOB inside a compound UNIQUE", async () => {
    expect(
      await findings(
        `CREATE TABLE pairs (
           id INTEGER PRIMARY KEY,
           a BLOB NOT NULL,
           b BLOB NOT NULL,
           UNIQUE (a, b)
         ) STRICT`,
        "blob-pk-or-unique-needs-check-length",
      ),
    ).toEqual([]);
  });
});

describe("fk-type-matches-parent", () => {
  it("fires when the child's type differs from the parent key's", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
           editor_id INTEGER REFERENCES authors(id) ON DELETE SET NULL
         ) STRICT`,
        "fk-type-matches-parent",
      ),
    ).toEqual(["books.author_id"]);
  });

  // A key that names no parent column refers to the parent's primary key.
  it("resolves a key with no parent column to the parent's primary key", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (handle TEXT PRIMARY KEY) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_handle INTEGER REFERENCES authors ON DELETE CASCADE
         ) STRICT`,
        "fk-type-matches-parent",
      ),
    ).toEqual(["books.author_handle"]);
  });
});

describe("fk-explicit-on-delete", () => {
  it("fires on a foreign key with no ON DELETE clause", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_id INTEGER NOT NULL REFERENCES authors(id),
           editor_id INTEGER REFERENCES authors(id) ON DELETE NO ACTION
         ) STRICT`,
        "fk-explicit-on-delete",
      ),
    ).toEqual(["books.author_id"]);
  });

  it("reads the table-constraint form", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_id INTEGER NOT NULL,
           editor_id INTEGER,
           FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE,
           FOREIGN KEY (editor_id) REFERENCES authors(id)
         ) STRICT`,
        "fk-explicit-on-delete",
      ),
    ).toEqual(["books.editor_id"]);
  });
});

describe("integer-pk-needs-autoincrement-on-fk-target", () => {
  // Only a table some key points at can re-link a stale child to a reused id.
  it("fires on a referenced INTEGER PRIMARY KEY without AUTOINCREMENT", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY) STRICT;
         CREATE TABLE publishers (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE loose_notes (id INTEGER PRIMARY KEY) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE,
           publisher_id INTEGER REFERENCES publishers(id) ON DELETE CASCADE
         ) STRICT`,
        "integer-pk-needs-autoincrement-on-fk-target",
      ),
    ).toEqual(["authors"]);
  });
});

describe("fk-needs-lead-index", () => {
  it("fires on a foreign key no index leads with", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
           editor_id INTEGER REFERENCES authors(id) ON DELETE SET NULL,
           title TEXT NOT NULL
         ) STRICT;
         CREATE INDEX idx_books_author ON books(author_id);
         CREATE INDEX idx_books_title_editor ON books(title, editor_id)`,
        "fk-needs-lead-index",
      ),
    ).toEqual(["books.editor_id"]);
  });

  // The primary key is its own index, and a UNIQUE constraint's index counts
  // like any other.
  it("counts the primary key and a UNIQUE constraint as an index", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE author_profiles (
           author_id INTEGER PRIMARY KEY REFERENCES authors(id) ON DELETE CASCADE
         ) STRICT;
         CREATE TABLE author_handles (
           id INTEGER PRIMARY KEY,
           author_id INTEGER NOT NULL UNIQUE REFERENCES authors(id) ON DELETE CASCADE
         ) STRICT`,
        "fk-needs-lead-index",
      ),
    ).toEqual([]);
  });
});

describe("with an allowlist", () => {
  // The recipe the README gives: every finding either fails the suite or is
  // an audited exception, and every exception still suppresses something.
  it("leaves only the findings no entry covers, and no unused entry", async () => {
    await applySchema(`
      CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
      CREATE TABLE legacy_tags (name TEXT);
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE
      ) STRICT
    `);
    // Typed as the README types it, a list whose rule ids are plain strings,
    // so the README's shape is the one that compiles here.
    const allowlist: AllowlistEntry[] = [
      {
        rule: "strict-required",
        table: "legacy_tags",
        reason:
          "read by an importer that writes untyped values; dropped next release",
      },
    ];
    const all = lintSchemaLayout(await readSchema(env.DB));
    const { remaining, unused } = applyAllowlist(all, allowlist);
    expect(remaining.map((f) => `${f.rule} ${f.table}.${f.column}`)).toEqual([
      "fk-needs-lead-index books.author_id",
    ]);
    expect(unused).toEqual([]);
  });
});
