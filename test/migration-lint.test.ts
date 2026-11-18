import { describe, expect, it } from "vitest";
import { checkDataLoss, findCascadeParents } from "../src/index";

// The lint reads statements, not an applied database, because every hazard it
// covers leaves the migrated schema looking exactly as intended: a cascaded
// wipe leaves the DDL right and the child tables empty, and a trigger or a
// generated column changes what writes mean without changing a table's shape.
// The cases below are the hazard each rule exists for, plus the evasions each
// rule has to survive to be worth having.

const rules = (migration: string, before: string) =>
  checkDataLoss(migration, before).map((f) => f.rule);

describe("cascade-parent wipe", () => {
  const BEFORE = `
    CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE
    );
  `;

  // The hazard the lint exists for: the standard rebuild drops the parent, and
  // the drop's implicit DELETE cascades into every child. Turning on
  // defer_foreign_keys first, as a migration author might, does not stop it.
  it("fires on the rebuild pattern that drops the parent", () => {
    const migration = `
      PRAGMA defer_foreign_keys = ON;
      CREATE TABLE authors_new (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pen_name TEXT);
      INSERT INTO authors_new (id, name) SELECT id, name FROM authors;
      DROP TABLE authors;
      ALTER TABLE authors_new RENAME TO authors;
    `;
    expect(rules(migration, BEFORE)).toEqual(["cascade-parent-wipe"]);
  });

  // RENAME rewrites each child's stored foreign key to follow the new name, so
  // renaming the parent aside and dropping it under the new name cascades
  // exactly the same. Without rename tracking this is a silent bypass.
  it("fires when the parent is renamed aside and then dropped", () => {
    const migration = `
      ALTER TABLE authors RENAME TO authors_old;
      CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      INSERT INTO authors (id, name) SELECT id, name FROM authors_old;
      DROP TABLE authors_old;
    `;
    expect(rules(migration, BEFORE)).toEqual(["cascade-parent-wipe"]);
  });

  // The rename is found by one whitespace character on each side of
  // RENAME TO, so runs of spaces and line breaks around it must still read
  // as the same rename.
  it("tracks a rename written across lines and runs of spaces", () => {
    const migration = `
      ALTER TABLE authors
          RENAME   TO
        authors_old;
      DROP TABLE authors_old;
    `;
    expect(rules(migration, BEFORE)).toEqual(["cascade-parent-wipe"]);
  });

  // Most drops are of leaf tables. Firing on those would make the lint noise,
  // and a noisy lint gets switched off.
  it("stays silent when the dropped table has no cascading children", () => {
    const before = `${BEFORE}\nCREATE TABLE import_runs (id INTEGER PRIMARY KEY);`;
    expect(checkDataLoss(`DROP TABLE import_runs;`, before)).toEqual([]);
  });

  // A child that references the parent with SET NULL loses no rows.
  it("stays silent for a non-CASCADE foreign key", () => {
    const before = `
      CREATE TABLE authors (id INTEGER PRIMARY KEY);
      CREATE TABLE shelves (
        curator_id INTEGER REFERENCES authors(id) ON DELETE SET NULL
      );
    `;
    expect(checkDataLoss(`DROP TABLE authors;`, before)).toEqual([]);
  });

  // Migrations explain in prose why they are NOT a rebuild. Reading that prose
  // as statements would fire on exactly the safe migrations.
  it("ignores destructive keywords in comments and string literals", () => {
    const migration = `
      -- ALTER TABLE ADD COLUMN rewrites no rows and runs no DROP TABLE authors,
      -- so none of the books children cascade.
      /* DROP TABLE authors; DELETE FROM authors; */
      ALTER TABLE authors ADD COLUMN note TEXT NOT NULL DEFAULT 'DROP TABLE authors';
    `;
    expect(checkDataLoss(migration, BEFORE)).toEqual([]);
  });

  // A parent read out of prose would block a legitimate leaf drop.
  it("does not read a cascade parent out of a comment", () => {
    const before = `
      -- shelves.curator_id INTEGER REFERENCES authors(id) ON DELETE CASCADE
      CREATE TABLE authors (id INTEGER PRIMARY KEY);
    `;
    expect(findCascadeParents(before).has("authors")).toBe(false);
  });

  // A plain \w+ read of the target would take `main` as the table, or stop at
  // the quote, and miss the parent.
  it("resolves quoted and schema-qualified drop targets", () => {
    expect(rules(`DROP TABLE main."authors";`, BEFORE)).toEqual([
      "cascade-parent-wipe",
    ]);
    expect(rules("DROP TABLE [authors];", BEFORE)).toEqual([
      "cascade-parent-wipe",
    ]);
    expect(rules("DROP TABLE IF EXISTS `Authors`;", BEFORE)).toEqual([
      "cascade-parent-wipe",
    ]);
  });

  it("matches a cascade parent declared without a column list", () => {
    const before = `
      CREATE TABLE authors (id INTEGER PRIMARY KEY);
      CREATE TABLE books (author_id INTEGER REFERENCES authors ON DELETE CASCADE);
    `;
    expect(findCascadeParents(before).has("authors")).toBe(true);
  });

  // ON UPDATE written before ON DELETE is the same foreign key; reading only
  // the first clause would miss the cascade.
  it("matches CASCADE after an ON UPDATE clause", () => {
    const before = `
      CREATE TABLE authors (id INTEGER PRIMARY KEY);
      CREATE TABLE books (
        author_id INTEGER REFERENCES authors(id) ON UPDATE RESTRICT ON DELETE CASCADE
      );
    `;
    expect(findCascadeParents(before).has("authors")).toBe(true);
  });
});

describe("unscoped row deletion", () => {
  const BEFORE = `CREATE TABLE authors (id INTEGER PRIMARY KEY);`;

  it("fires on a DELETE with no WHERE", () => {
    expect(rules(`DELETE FROM authors;`, BEFORE)).toEqual(["unscoped-delete"]);
  });

  it("stays silent on a scoped DELETE", () => {
    expect(checkDataLoss(`DELETE FROM authors WHERE id = 7;`, BEFORE)).toEqual(
      [],
    );
  });

  // A CTE prefix moves the DELETE off the start of the statement, past a
  // check anchored on `^DELETE`.
  it("fires on a CTE-prefixed DELETE with no WHERE", () => {
    const migration = `WITH doomed AS (SELECT id FROM authors) DELETE FROM authors;`;
    expect(rules(migration, BEFORE)).toEqual(["unscoped-delete"]);
  });

  // The statement contains WHERE, but it belongs to the CTE's SELECT. Testing
  // the whole statement for WHERE reads this full-table wipe as scoped.
  it("fires when the only WHERE belongs to the CTE, not the DELETE", () => {
    const migration = `WITH doomed AS (SELECT id FROM authors WHERE id > 5) DELETE FROM authors;`;
    expect(rules(migration, BEFORE)).toEqual(["unscoped-delete"]);
  });

  it("stays silent on a CTE-prefixed DELETE that is scoped", () => {
    const migration = `WITH doomed AS (SELECT id FROM authors WHERE id > 5) DELETE FROM authors WHERE id IN (SELECT id FROM doomed);`;
    expect(checkDataLoss(migration, BEFORE)).toEqual([]);
  });
});

describe("unparseable destructive target", () => {
  // A target that will not parse cannot be checked for either hazard. Passing
  // it would be indistinguishable from a clean migration.
  it("fires on an unterminated quoted drop target", () => {
    expect(rules(`DROP TABLE "authors;`, `CREATE TABLE x (a);`)).toEqual([
      "unparseable-target",
    ]);
  });

  it("fires on a dangling schema qualifier", () => {
    expect(rules(`DELETE FROM main.;`, `CREATE TABLE x (a);`)).toEqual([
      "unparseable-target",
    ]);
  });
});

describe("triggers", () => {
  const BEFORE = `CREATE TABLE authors (id INTEGER PRIMARY KEY);`;

  // A trigger changes what an existing write does while the write keeps
  // succeeding, and a schema comparison over tables and indexes never sees it.
  it("fires on CREATE TRIGGER", () => {
    const migration = `CREATE TRIGGER trg AFTER INSERT ON authors BEGIN SELECT 1; END;`;
    expect(rules(migration, BEFORE)).toEqual(["trigger-semantics"]);
  });

  it("fires on the TEMP and IF NOT EXISTS forms", () => {
    expect(
      rules(
        `CREATE TEMP TRIGGER trg BEFORE UPDATE ON authors BEGIN SELECT 1; END;`,
        BEFORE,
      ),
    ).toEqual(["trigger-semantics"]);
    expect(
      rules(
        `CREATE TRIGGER IF NOT EXISTS trg AFTER INSERT ON authors BEGIN SELECT 1; END;`,
        BEFORE,
      ),
    ).toEqual(["trigger-semantics"]);
  });

  // The same class in reverse: writes keep succeeding while a side effect
  // that code relied on vanishes.
  it("fires on DROP TRIGGER", () => {
    expect(rules(`DROP TRIGGER IF EXISTS trg;`, BEFORE)).toEqual([
      "trigger-semantics",
    ]);
    expect(rules(`DROP TRIGGER trg;`, BEFORE)).toEqual(["trigger-semantics"]);
  });

  // The tokenizer splits a BEGIN...END body at its inner semicolons, so a
  // destructive statement in the body surfaces as a fragment of its own. The
  // trigger must still be found: its head fragment starts with CREATE TRIGGER.
  it("still finds the trigger when its body carries a destructive statement", () => {
    const migration = `CREATE TRIGGER trg AFTER INSERT ON authors BEGIN UPDATE authors SET id = id; DELETE FROM authors; END;`;
    expect(rules(migration, BEFORE)).toContain("trigger-semantics");
  });

  // No target is parsed, so a malformed statement that still reads as CREATE
  // TRIGGER cannot get past by being unparseable.
  it("fires on a malformed CREATE TRIGGER with an unterminated quote", () => {
    expect(rules(`CREATE TRIGGER "trg ON authors;`, BEFORE)).toEqual([
      "trigger-semantics",
    ]);
  });

  it("ignores TRIGGER in comments and string literals", () => {
    const migration = `
      -- No CREATE TRIGGER here: this migration is additive.
      /* DROP TRIGGER trg; */
      ALTER TABLE authors ADD COLUMN note TEXT DEFAULT 'CREATE TRIGGER trg';
    `;
    expect(checkDataLoss(migration, BEFORE)).toEqual([]);
  });
});

describe("generated columns", () => {
  const BEFORE = `CREATE TABLE authors (id INTEGER PRIMARY KEY);`;

  // A generated column changes what a stored row means while every write
  // keeps succeeding, and the expected schema carries the same column.
  it("fires on ADD COLUMN ... GENERATED ALWAYS AS", () => {
    const migration = `ALTER TABLE authors ADD COLUMN doubled INTEGER GENERATED ALWAYS AS (id * 2) VIRTUAL;`;
    expect(rules(migration, BEFORE)).toEqual(["generated-column-semantics"]);
  });

  // SQLite accepts the bare `AS (expr)` shorthand with the same meaning;
  // matching only GENERATED ALWAYS would be a one-keyword bypass.
  it("fires on the bare AS (expr) shorthand", () => {
    const migration = `ALTER TABLE authors ADD COLUMN doubled INTEGER AS (id * 2);`;
    expect(rules(migration, BEFORE)).toEqual(["generated-column-semantics"]);
  });

  // A rebuild creates the replacement under a new name and renames it over
  // the original, so exempting new tables would let a rebuild add one to an
  // existing table.
  it("fires on a generated column inside CREATE TABLE", () => {
    const migration = `
      CREATE TABLE authors_new (
        id INTEGER PRIMARY KEY,
        doubled INTEGER GENERATED ALWAYS AS (id * 2) STORED
      );
    `;
    expect(rules(migration, BEFORE)).toEqual(["generated-column-semantics"]);
  });

  // An unterminated quote swallows the rest of the file, and the statement
  // still shows the generated-column grammar; being malformed must not hide it.
  it("fires on a malformed statement that still shows AS (", () => {
    const migration = `ALTER TABLE authors ADD COLUMN "doubled INTEGER GENERATED ALWAYS AS (id * 2);`;
    expect(rules(migration, BEFORE)).toEqual(["generated-column-semantics"]);
  });

  // `AS (` outside a column definition is CTE grammar, and CAST's AS takes a
  // bare type name. Firing on either would make the lint noise.
  it("stays silent on CTE and CAST uses of AS", () => {
    const migration = `
      WITH doomed AS (SELECT id FROM authors WHERE id > 5) DELETE FROM authors WHERE id IN (SELECT id FROM doomed);
      ALTER TABLE authors ADD COLUMN casted TEXT CHECK (CAST(casted AS INTEGER) >= 0);
    `;
    expect(checkDataLoss(migration, BEFORE)).toEqual([]);
  });

  // The additive statements routine migrations are made of must pass with
  // nothing declared.
  it("stays silent on plain additive ADD COLUMN and CREATE TABLE", () => {
    const migration = `
      CREATE TABLE review_notes (id INTEGER PRIMARY KEY, body TEXT) STRICT;
      CREATE INDEX idx_review_notes_body ON review_notes(body);
      ALTER TABLE authors ADD COLUMN nickname TEXT;
      ALTER TABLE authors ADD COLUMN joined_at INTEGER NOT NULL DEFAULT (unixepoch());
    `;
    expect(checkDataLoss(migration, BEFORE)).toEqual([]);
  });
});

describe("findings", () => {
  // A finding's message is what a person reads in a failed check, so it has
  // to name the statement; one per hazard, in statement order.
  it("reports each hazard once, in order, naming its statement", () => {
    const findings = checkDataLoss(
      `DELETE FROM authors;\nCREATE TRIGGER trg AFTER INSERT ON authors BEGIN SELECT 1; END;`,
      `CREATE TABLE authors (id INTEGER PRIMARY KEY);`,
    );
    expect(findings.map((f) => f.rule)).toEqual([
      "unscoped-delete",
      "trigger-semantics",
    ]);
    expect(findings[0]?.message).toContain('"DELETE FROM authors"');
  });
});
