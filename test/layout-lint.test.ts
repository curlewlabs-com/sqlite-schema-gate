import { env } from "cloudflare:workers";
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

  // A generated column is a column every rule has to see: one can be a
  // UNIQUE BLOB key or a foreign key like any other.
  it("reads generated columns", async () => {
    await applySchema(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        body BLOB NOT NULL,
        digest BLOB GENERATED ALWAYS AS (substr(body, 1, 8)) STORED UNIQUE,
        size INTEGER AS (length(body))
      ) STRICT
    `);
    const snapshot = await readSchema(env.DB);
    expect(snapshot.columns.get("files")?.map((c) => c.name)).toEqual([
      "id",
      "body",
      "digest",
      "size",
    ]);
    expect(
      lintSchemaLayout(snapshot)
        .filter((f) => f.rule === "blob-pk-or-unique-needs-check-length")
        .map((f) => f.column),
    ).toEqual(["digest"]);
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

  // The CHECK is read as tokens: a quoted column name and `==` are the same
  // check to SQLite, and a string default that spells one is not a check.
  it("reads the length CHECK as SQLite does, not as text", async () => {
    expect(
      await findings(
        `CREATE TABLE quoted (slug BLOB PRIMARY KEY CHECK (length("slug") == 16)) STRICT;
         CREATE TABLE spelled (
           slug BLOB PRIMARY KEY,
           note TEXT DEFAULT 'CHECK (length(slug) = 16)'
         ) STRICT`,
        "blob-pk-or-unique-needs-check-length",
      ),
    ).toEqual(["spelled.slug"]);
  });

  // The exemption defers to a referenced column's CHECK. A key whose parent
  // has none, or that references only itself, has nothing to defer to; one
  // that references a checked column, in its own table or beside an
  // unchecked one, is checked by it.
  it("exempts a BLOB key only when a column it references is checked", async () => {
    expect(
      await findings(
        `CREATE TABLE loose_links (slug BLOB PRIMARY KEY) STRICT;
         CREATE TABLE loose_visits (
           slug BLOB PRIMARY KEY REFERENCES loose_links(slug) ON DELETE CASCADE
         ) STRICT;
         CREATE TABLE loops (
           id BLOB PRIMARY KEY REFERENCES loops(id) ON DELETE CASCADE
         ) STRICT;
         CREATE TABLE revisions (
           id BLOB PRIMARY KEY CHECK (length(id) = 16),
           parent_id BLOB UNIQUE REFERENCES revisions(id) ON DELETE CASCADE
         ) STRICT;
         CREATE TABLE checked_links (slug BLOB PRIMARY KEY CHECK (length(slug) = 16)) STRICT;
         CREATE TABLE both_visits (
           slug BLOB PRIMARY KEY
             REFERENCES loose_links(slug) ON DELETE CASCADE
             REFERENCES checked_links(slug) ON DELETE CASCADE
         ) STRICT`,
        "blob-pk-or-unique-needs-check-length",
      ),
    ).toEqual(["loops.id", "loose_links.slug", "loose_visits.slug"]);
  });

  // SQLite does not check a composite key any of whose columns is NULL, so a
  // companion column that may be NULL lets any bytes through.
  it("exempts a BLOB in a composite key only when its companions are NOT NULL", async () => {
    expect(
      await findings(
        `CREATE TABLE scopes (
           id BLOB NOT NULL CHECK (length(id) = 16),
           scope INTEGER NOT NULL,
           PRIMARY KEY (id, scope)
         ) STRICT;
         CREATE TABLE loose (
           id BLOB PRIMARY KEY,
           scope INTEGER,
           FOREIGN KEY (id, scope) REFERENCES scopes ON DELETE CASCADE
         ) STRICT;
         CREATE TABLE strict_pairs (
           id BLOB PRIMARY KEY,
           scope INTEGER NOT NULL,
           FOREIGN KEY (id, scope) REFERENCES scopes ON DELETE CASCADE
         ) STRICT`,
        "blob-pk-or-unique-needs-check-length",
      ),
    ).toEqual(["loose.id"]);
  });

  // An INTEGER PRIMARY KEY that aliases the rowid never holds NULL, though
  // the pragma reports it nullable, so as a companion it keeps the key
  // checked. One declared DESC is no alias, and outside STRICT it may hold
  // NULL.
  it("counts a rowid alias companion as NOT NULL", async () => {
    expect(
      await findings(
        `CREATE TABLE tokens (
           b BLOB NOT NULL CHECK (length(b) = 16),
           n INTEGER NOT NULL,
           PRIMARY KEY (b, n)
         ) STRICT;
         CREATE TABLE uses (
           n INTEGER PRIMARY KEY,
           b BLOB UNIQUE,
           FOREIGN KEY (b, n) REFERENCES tokens ON DELETE CASCADE
         );
         CREATE TABLE late_uses (
           n INTEGER PRIMARY KEY DESC,
           b BLOB UNIQUE,
           FOREIGN KEY (b, n) REFERENCES tokens ON DELETE CASCADE
         )`,
        "blob-pk-or-unique-needs-check-length",
      ),
    ).toEqual(["late_uses.b"]);
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

  // SQLite resolves a foreign key's parent with case folded, so the parent
  // is found however the key spells it.
  it("finds a parent written in another case", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_id TEXT REFERENCES AUTHORS(ID) ON DELETE CASCADE
         ) STRICT`,
        "fk-type-matches-parent",
      ),
    ).toEqual(["books.author_id"]);
  });

  // A composite key with no parent columns maps each of its columns to the
  // parent's primary key column at the same position, which need not be the
  // order the parent declares its columns in.
  it("compares a composite key position by position", async () => {
    expect(
      await findings(
        `CREATE TABLE editions (
           isbn TEXT NOT NULL,
           printing INTEGER NOT NULL,
           PRIMARY KEY (printing, isbn)
         ) STRICT;
         CREATE TABLE copies (
           id INTEGER PRIMARY KEY,
           printing TEXT,
           isbn TEXT,
           FOREIGN KEY (printing, isbn) REFERENCES editions ON DELETE CASCADE
         ) STRICT`,
        "fk-type-matches-parent",
      ),
    ).toEqual(["copies.printing"]);
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

  // SQLite lets table constraints follow one another with no comma, and each
  // keeps its own clauses; a single-quoted name in the column list is a name.
  it("reads each of several adjacent table constraints on its own", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_id INTEGER,
           editor_id INTEGER,
           agent_id INTEGER,
           FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
           FOREIGN KEY (editor_id) REFERENCES authors(id)
           CONSTRAINT agent FOREIGN KEY ('agent_id') REFERENCES authors(id) ON DELETE SET NULL
         ) STRICT`,
        "fk-explicit-on-delete",
      ),
    ).toEqual(["books.editor_id"]);
  });

  // Two keys over the same column and parent are each a decision; the one
  // that writes no clause is not covered by the one that does.
  it("reads each of two keys over one column and parent", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE,
           FOREIGN KEY (author_id) REFERENCES authors(id)
         ) STRICT`,
        "fk-explicit-on-delete",
      ),
    ).toEqual(["books.author_id", "books.author_id"]);
  });

  // A column named with a dotless i (U+0131) that looks like PRIMARY is a
  // column, and its foreign key's clause is read from it.
  it("reads a column whose name only looks like a constraint keyword", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           pr\u0131mary INTEGER REFERENCES authors(id) ON DELETE CASCADE
         ) STRICT`,
        "fk-explicit-on-delete",
      ),
    ).toEqual([]);
  });

  // The clause is the key's own, read as tokens: a quoted parent or a MATCH
  // clause before it still writes it, and a string that spells it does not.
  it("reads the ON DELETE clause as SQLite does, not as text", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_id INTEGER REFERENCES "authors"(id) ON DELETE CASCADE,
           editor_id INTEGER REFERENCES authors(id) MATCH SIMPLE ON DELETE SET NULL,
           agent_id INTEGER REFERENCES Authors(id) DEFAULT 'ON DELETE CASCADE',
           "Reviewer_Id" INTEGER,
           FOREIGN KEY ("reviewer_id") REFERENCES [authors] ON DELETE NO ACTION
         ) STRICT`,
        "fk-explicit-on-delete",
      ),
    ).toEqual(["books.agent_id"]);
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

  // Neither the key of a WITHOUT ROWID table nor one declared
  // `PRIMARY KEY DESC` is a rowid alias: neither reuses a freed rowid, and
  // SQLite refuses AUTOINCREMENT on both.
  it("stays silent on an INTEGER PRIMARY KEY that is not a rowid alias", async () => {
    expect(
      await findings(
        `CREATE TABLE clustered (id INTEGER PRIMARY KEY, name TEXT) STRICT, WITHOUT ROWID;
         CREATE TABLE descending (id INTEGER PRIMARY KEY DESC) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           clustered_id INTEGER REFERENCES clustered(id) ON DELETE CASCADE,
           descending_id INTEGER REFERENCES descending(id) ON DELETE CASCADE
         ) STRICT`,
        "integer-pk-needs-autoincrement-on-fk-target",
      ),
    ).toEqual([]);
  });

  // SQLite folds only ASCII letters, so a name or a type spelled with a
  // dotless i (U+0131) is not the keyword or the type it looks like: a
  // column so named is not AUTOINCREMENT, and a key so typed is not INTEGER.
  it("folds keywords and types as SQLite does, ASCII only", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY, auto\u0131ncrement TEXT) STRICT;
         CREATE TABLE agents (id \u0131nteger PRIMARY KEY);
         CREATE TABLE books (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE,
           agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE
         ) STRICT`,
        "integer-pk-needs-autoincrement-on-fk-target",
      ),
    ).toEqual(["authors"]);
  });

  // A string default that spells AUTOINCREMENT is not the keyword.
  it("does not read AUTOINCREMENT out of a string", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (
           id INTEGER PRIMARY KEY,
           note TEXT DEFAULT 'id INTEGER PRIMARY KEY AUTOINCREMENT'
         ) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE
         ) STRICT`,
        "integer-pk-needs-autoincrement-on-fk-target",
      ),
    ).toEqual(["authors"]);
  });

  // The target is found however the key spells its name.
  it("counts a target named in another case", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY) STRICT;
         CREATE TABLE books (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           author_id INTEGER REFERENCES AUTHORS(ID) ON DELETE CASCADE
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

  // A composite key's check looks the child up by all of its columns at
  // once, so a primary key or index that leads with any of them serves it.
  it("reads a composite key as one key", async () => {
    expect(
      await findings(
        `CREATE TABLE editions (isbn TEXT, printing INTEGER, PRIMARY KEY (isbn, printing)) STRICT;
         CREATE TABLE copies (
           isbn TEXT,
           printing INTEGER,
           PRIMARY KEY (isbn, printing),
           FOREIGN KEY (isbn, printing) REFERENCES editions ON DELETE CASCADE
         ) STRICT;
         CREATE TABLE loans (
           id INTEGER PRIMARY KEY,
           isbn TEXT,
           printing INTEGER,
           FOREIGN KEY (isbn, printing) REFERENCES editions ON DELETE CASCADE
         ) STRICT;
         CREATE TABLE holds (
           id INTEGER PRIMARY KEY,
           isbn TEXT,
           printing INTEGER,
           FOREIGN KEY (isbn, printing) REFERENCES editions ON DELETE CASCADE
         ) STRICT;
         CREATE INDEX idx_holds_printing ON holds(printing)`,
        "fk-needs-lead-index",
      ),
    ).toEqual(["loans.isbn"]);
  });

  // Only the primary key's first column can be sought into.
  it("counts only the primary key's first column as an index", async () => {
    expect(
      await findings(
        `CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
         CREATE TABLE memberships (
           group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
           author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE,
           PRIMARY KEY (group_id, author_id)
         ) STRICT`,
        "fk-needs-lead-index",
      ),
    ).toEqual(["memberships.author_id"]);
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
