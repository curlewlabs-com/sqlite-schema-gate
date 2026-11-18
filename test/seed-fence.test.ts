import { describe, expect, it } from "vitest";
import { checkDataSeed, type SeedTables } from "../src/index";

// The fence is a whitelist over a file applied on every deploy, so the cases
// are the ways past one: statements that are not an append, appends that are
// not literal, and literal appends that silently never land.

const TABLES: SeedTables = {
  tax_rates: ["id", "starts_at"],
  currencies: ["id", "iso_code"],
};

const rules = (sql: string, tables: SeedTables = TABLES) =>
  checkDataSeed(sql, tables).map((f) => f.rule);

describe("statements that are not idempotent literal inserts", () => {
  it("fires on DDL", () => {
    expect(rules("CREATE TABLE tax_rates (id INTEGER PRIMARY KEY);")).toEqual([
      "not-insert-or-ignore",
    ]);
  });

  // Not special-cased anywhere - the whitelist rejects them by their not being
  // an INSERT OR IGNORE - which is why each gets a case.
  it("fires on DELETE and UPDATE", () => {
    expect(
      rules(`
        DELETE FROM currencies WHERE id = 22;
        UPDATE tax_rates SET label = 'x' WHERE id = 1;
      `),
    ).toEqual(["not-insert-or-ignore", "not-insert-or-ignore"]);
  });

  // The near miss: it reads as correct in review and fails on the SECOND
  // deploy, on a primary key collision.
  it("fires on a plain INSERT into a seed table", () => {
    expect(
      rules("INSERT INTO currencies (id, iso_code) VALUES (23, 'x');"),
    ).toEqual(["not-insert-or-ignore"]);
  });

  // OR REPLACE survives a re-run as OR IGNORE does, which is why the rule is
  // not "does it re-run cleanly": it overwrites the live row, so editing a
  // value in place would rewrite production data on the next deploy.
  it("fires on INSERT OR REPLACE", () => {
    expect(
      rules(
        "INSERT OR REPLACE INTO currencies (id, iso_code) VALUES (1, 'renamed');",
      ),
    ).toEqual(["not-insert-or-ignore"]);
  });

  it("fires on a row source that reads live data", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO currencies (id, iso_code) SELECT id, iso_code FROM old_currencies;",
      ),
    ).toEqual(["non-literal-rows"]);
  });

  // SQLite accepts an upsert tail on INSERT OR IGNORE, and it REWRITES the
  // conflicting row: this reads as the permitted append and overwrites live
  // data on every deploy.
  it("fires on an upsert tail after a literal VALUES list", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (1, 'renamed') " +
          "ON CONFLICT(id) DO UPDATE SET iso_code = excluded.iso_code;",
      ),
    ).toEqual(["non-literal-rows"]);
  });

  it("fires on a trailing clause the tail grammar does not permit", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (23, 'x') RETURNING id;",
      ),
    ).toEqual(["non-literal-rows"]);
  });

  // An expression is not a literal even when it looks constant: the database
  // resolves its value, so the file's text no longer says what lands.
  it("fires on a computed value in the tuple", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO tax_rates (id, starts_at, label) " +
          "VALUES (9, unixepoch('now'), 'standard');",
      ),
    ).toEqual(["non-literal-rows"]);
  });

  // No column list leaves no identity column a known position. It is
  // rejected at the head rather than silently left unchecked.
  it("fires on a positional insert with no column list", () => {
    expect(rules("INSERT OR IGNORE INTO currencies VALUES (23, 'x');")).toEqual(
      ["not-insert-or-ignore"],
    );
  });
});

// Silent in both directions: the database drops the row, and an expected set
// built by running the same file drops it too and agrees with itself.
describe("a row that collides with one the file already wrote", () => {
  it("fires on a reused primary key", () => {
    expect(
      rules(`
        INSERT OR IGNORE INTO tax_rates (id, starts_at, label) VALUES (8, 1700000000, 'a');
        INSERT OR IGNORE INTO tax_rates (id, starts_at, label) VALUES (8, 1710000000, 'b');
      `),
    ).toEqual(["duplicate-authored-identity"]);
  });

  // A fresh primary key is not enough when another column is UNIQUE.
  it("fires on a reused UNIQUE column with a fresh primary key", () => {
    expect(
      rules(`
        INSERT OR IGNORE INTO tax_rates (id, starts_at, label) VALUES (8, 1700000000, 'a');
        INSERT OR IGNORE INTO tax_rates (id, starts_at, label) VALUES (9, 1700000000, 'b');
      `),
    ).toEqual(["duplicate-authored-identity"]);
  });

  // Why the rule reads raw values: the keyword view blanks every string to ''
  // and would call all of these duplicates.
  it("fires on a reused text identity, and not on distinct ones", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (23, 'x'), (24, 'x');",
      ),
    ).toEqual(["duplicate-authored-identity"]);
    expect(
      rules(
        "INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (23, 'x'), (24, 'y');",
      ),
    ).toEqual([]);
  });

  // The tail grammar reads a string with an escaped quote ('it''s') as two
  // literals with no comma between them, so the row is reported rather than
  // admitted: a false finding, never a missed one. The README's Limits say so;
  // this pins the direction.
  it("reports a string literal holding an escaped quote", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (1, 'it''s');",
      ),
    ).toEqual(["non-literal-rows"]);
  });

  // Same value, different form: comparing raw text would read these as
  // separate identities where SQLite reads one.
  it("fires on a numerically equal identity written differently", () => {
    expect(
      rules(`
        INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (23, 'x');
        INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (023, 'y');
      `),
    ).toEqual(["duplicate-authored-identity"]);
  });

  // An omitted identity column hands the row's identity to a DEFAULT the
  // fence cannot evaluate, so it cannot be cleared.
  it("fires when an identity column is omitted from the column list", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO tax_rates (starts_at, label) VALUES (1710000000, 'b');",
      ),
    ).toEqual(["duplicate-authored-identity"]);
  });
});

describe("targets outside the seed tables", () => {
  it("fires on a table that is not a seed table", () => {
    expect(
      rules("INSERT OR IGNORE INTO authors (id, name) VALUES (1, 'x');"),
    ).toEqual(["table-not-allowlisted"]);
  });

  // A quoted or schema-qualified target is not resolved to the table it names;
  // it fails to match the one permitted opening, which keeps the fence closed
  // without a second identifier parser.
  it("fires on quoted and schema-qualified targets", () => {
    expect(
      rules(`
        INSERT OR IGNORE INTO "currencies" (id, iso_code) VALUES (23, 'x');
        INSERT OR IGNORE INTO main.currencies (id, iso_code) VALUES (24, 'y');
      `),
    ).toEqual(["not-insert-or-ignore", "not-insert-or-ignore"]);
  });

  // The caller's table map is read as a map: a table named like an Object
  // member must not count as a seed table because the record happens to
  // inherit that name.
  it("does not treat an inherited object member as a seed table", () => {
    expect(rules("INSERT OR IGNORE INTO constructor (id) VALUES (1);")).toEqual(
      ["table-not-allowlisted"],
    );
  });

  // SQLite compares names case-insensitively, so a map written in another
  // case still names the same tables and columns.
  it("matches seed tables and identity columns case-insensitively", () => {
    const mixed: SeedTables = { Currencies: ["ID", "ISO_Code"] };
    expect(
      rules(
        "INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (1, 'x'), (2, 'x');",
        mixed,
      ),
    ).toEqual(["duplicate-authored-identity"]);
  });
});

describe("evasions the whitelist has to survive", () => {
  // A seed file is mostly prose explaining each row. A rule that read comments
  // would fire on all of it.
  it("ignores statements written in comments", () => {
    expect(
      rules(`
        -- Superseded: DROP TABLE currencies;
        /* DELETE FROM tax_rates; */
        INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (23, 'x');
      `),
    ).toEqual([]);
  });

  // A row's value is free-form text, and a naive split on `;` would read the
  // tail of one as a second statement.
  it("does not read a statement out of a string literal", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (23, 'x; DROP TABLE authors');",
      ),
    ).toEqual([]);
  });

  // NULL and negative numbers are literals a lookup row may hold; the tail
  // grammar has to admit them or the fence fires on inert content.
  it("accepts NULL and negative literals in a tuple", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO tax_rates (id, starts_at, label) VALUES (9, -1, NULL);",
      ),
    ).toEqual([]);
  });

  // The fence must not depend on formatting, which is the part a later edit
  // changes freely.
  it("accepts a multi-row insert split across lines", () => {
    expect(
      rules(`
        INSERT OR IGNORE INTO currencies
          (id, iso_code)
        VALUES
          (23, 'x'),
          (24, 'y');
      `),
    ).toEqual([]);
  });
});
