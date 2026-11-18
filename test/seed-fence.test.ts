import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
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

  // A string holding an escaped quote is one literal, as SQLite reads it, and
  // its identity is its content with the quote undone.
  it("reads a string literal holding an escaped quote as one value", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (1, 'it''s'), (2, 'it''s');",
      ),
    ).toEqual(["duplicate-authored-identity"]);
  });

  // Spacing is the formatter's choice; the grammar reads tokens.
  it("accepts a column list and tuples written without spaces", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO currencies(id,iso_code)VALUES(1,'x'),(2,'y');",
      ),
    ).toEqual([]);
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

describe("NULL identity values", () => {
  // An INTEGER PRIMARY KEY given NULL takes a new rowid, so a row whose only
  // identity is that key is appended again on every apply and the table grows
  // by one copy per deploy.
  it("fires on NULL in an integer primary key", () => {
    expect(
      rules("INSERT OR IGNORE INTO tags (id, name) VALUES (NULL, 'x');", {
        tags: ["id"],
      }),
    ).toEqual(["duplicate-authored-identity"]);
  });

  // A UNIQUE column holds any number of NULLs, so NULL there is no identity
  // either, in any case it is written in. Two such rows are each reported
  // once, not once more as a repeat of the other.
  it("fires once per NULL in a UNIQUE identity column, in any case", () => {
    const findings = checkDataSeed(
      `INSERT OR IGNORE INTO currencies (id, iso_code) VALUES (23, null), (24, NULL);`,
      TABLES,
    );
    expect(findings.map((f) => f.rule)).toEqual([
      "duplicate-authored-identity",
      "duplicate-authored-identity",
    ]);
    expect(findings[0]?.message).toContain(
      "`currencies.iso_code` the value NULL",
    );
  });

  // NULL outside the identity columns is ordinary content, as the
  // tuple-grammar case below also holds.
  it("stays silent on NULL in a column that is not an identity", () => {
    expect(
      rules(
        "INSERT OR IGNORE INTO tax_rates (id, starts_at, label) VALUES (9, 1, NULL);",
      ),
    ).toEqual([]);
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

  // A table with no primary key or UNIQUE column gives OR IGNORE nothing to
  // conflict on, so its rows are inserted again on every apply. An empty
  // identity list would skip every collision check and pass them.
  it("refuses a seed table declared with no identity columns", () => {
    expect(() =>
      checkDataSeed("INSERT OR IGNORE INTO tags (name) VALUES ('x');", {
        tags: [],
      }),
    ).toThrow(/identity columns[\s\S]*none given for: tags/);
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

describe("identity as SQLite compares it", () => {
  // Each case applies the seed rows to a D1 table declared as `ddl` says and
  // counts what lands: a row OR IGNORE dropped is a collision. The fence,
  // which reads only the file and the declared keys, must report exactly
  // those, or, where a case says so, more.
  const cases: {
    what: string;
    ddl: string;
    columns: string[];
    keys: SeedTables[string];
    rows: string;
    superset?: true;
  }[] = [
    {
      what: "integers past 2^53 that share a double, in a REAL column",
      ddl: "id INTEGER PRIMARY KEY, r REAL UNIQUE",
      columns: ["id", "r"],
      keys: ["id", "r"],
      rows: "(1, 9007199254740993), (2, 9007199254740992)",
    },
    {
      // Distinct in an INTEGER column; the fence, which does not read the
      // column's type, calls them one. A false finding only.
      what: "integers past 2^53 that share a double, in an INTEGER column",
      ddl: "id INTEGER PRIMARY KEY",
      columns: ["id"],
      keys: ["id"],
      rows: "(9007199254740993), (9007199254740992)",
      superset: true,
    },
    {
      what: "the least 64-bit integer and the same real, in a BLOB column",
      ddl: "id INTEGER PRIMARY KEY, b BLOB UNIQUE",
      columns: ["id", "b"],
      keys: ["id", "b"],
      rows: "(1, -9223372036854775808), (2, -9223372036854775808.0)",
    },
    {
      what: "the same integer past 2^53 twice",
      ddl: "id INTEGER PRIMARY KEY",
      columns: ["id"],
      keys: ["id"],
      rows: "(9223372036854775807), (9223372036854775807)",
    },
    {
      what: "an integer and the same real",
      ddl: "id INTEGER PRIMARY KEY",
      columns: ["id"],
      keys: ["id"],
      rows: "(1), (1.0)",
    },
    {
      what: "a number and its text in an INTEGER column",
      ddl: "id INTEGER PRIMARY KEY, n INTEGER UNIQUE",
      columns: ["id", "n"],
      keys: ["id", "n"],
      rows: "(1, 7), (2, '7')",
    },
    {
      what: "a number and its text in a TEXT column",
      ddl: "id INTEGER PRIMARY KEY, code TEXT UNIQUE",
      columns: ["id", "code"],
      keys: ["id", "code"],
      rows: "(1, 7), (2, '7')",
    },
    {
      what: "text that differs only in case, under BINARY",
      ddl: "id INTEGER PRIMARY KEY, code TEXT UNIQUE",
      columns: ["id", "code"],
      keys: ["id", "code"],
      rows: "(1, 'USD'), (2, 'usd')",
    },
    {
      what: "text that differs only in case, under NOCASE",
      ddl: "id INTEGER PRIMARY KEY, code TEXT COLLATE NOCASE UNIQUE",
      columns: ["id", "code"],
      keys: ["id", { columns: ["code"], collate: { code: "NOCASE" } }],
      rows: "(1, 'USD'), (2, 'usd')",
    },
    {
      what: "text that differs only in trailing spaces, under RTRIM",
      ddl: "id INTEGER PRIMARY KEY, code TEXT COLLATE RTRIM UNIQUE",
      columns: ["id", "code"],
      keys: ["id", { columns: ["code"], collate: { code: "RTRIM" } }],
      rows: "(1, 'usd'), (2, 'usd  ')",
    },
    {
      what: "rows of a composite UNIQUE that share one column",
      ddl: "id INTEGER PRIMARY KEY, a INTEGER, b TEXT, UNIQUE (a, b)",
      columns: ["id", "a", "b"],
      keys: ["id", { columns: ["a", "b"] }],
      rows: "(1, 1, 'x'), (2, 1, 'y'), (3, 2, 'x')",
    },
    {
      what: "rows of a composite UNIQUE that share both columns",
      ddl: "id INTEGER PRIMARY KEY, a INTEGER, b TEXT, UNIQUE (a, b)",
      columns: ["id", "a", "b"],
      keys: ["id", { columns: ["a", "b"] }],
      rows: "(1, 1, 'x'), (2, 1, 'x')",
    },
    {
      what: "a composite UNIQUE compared under NOCASE in one column",
      ddl: "id INTEGER PRIMARY KEY, a INTEGER, b TEXT COLLATE NOCASE, UNIQUE (a, b)",
      columns: ["id", "a", "b"],
      keys: ["id", { columns: ["a", "b"], collate: { b: "NOCASE" } }],
      rows: "(1, 1, 'x'), (2, 1, 'X')",
    },
    {
      // How many digits a TEXT column keeps of a real depends on the SQLite
      // release: this one keeps them all, so the pair stays apart, where one
      // rendering 15 digits would collide them. The fence cannot know which
      // it runs against, and reports such a real wherever it is.
      what: "a real with more than 15 significant digits, in a TEXT column",
      ddl: "id INTEGER PRIMARY KEY, code TEXT UNIQUE",
      columns: ["id", "code"],
      keys: ["id", "code"],
      rows: "(1, 1.2345678901234567), (2, '1.23456789012346')",
      superset: true,
    },
    {
      what: "a real too large for a double, in a TEXT column",
      ddl: "id INTEGER PRIMARY KEY, code TEXT UNIQUE",
      columns: ["id", "code"],
      keys: ["id", "code"],
      rows: `(1, ${"9".repeat(400)}), (2, 'Inf')`,
    },
    {
      // A TEXT column keeps '01' and '1' apart; the fence, which does not
      // read the column's type, calls them one. A false finding only.
      what: "numeric-looking text in a TEXT column",
      ddl: "id INTEGER PRIMARY KEY, code TEXT UNIQUE",
      columns: ["id", "code"],
      keys: ["id", "code"],
      rows: "(1, '01'), (2, '1')",
      superset: true,
    },
  ];

  for (const c of cases) {
    it(c.what, async () => {
      await env.DB.batch([
        env.DB.prepare("DROP TABLE IF EXISTS t"),
        env.DB.prepare(`CREATE TABLE t (${c.ddl})`),
      ]);
      const seed = `INSERT OR IGNORE INTO t (${c.columns.join(", ")}) VALUES ${c.rows};`;
      await env.DB.prepare(seed).run();
      const landed = await env.DB.prepare("SELECT count(*) AS n FROM t").first<{
        n: number;
      }>();
      const authored = c.rows.split("), (").length;
      const collides = landed!.n < authored;
      const reported = checkDataSeed(seed, { t: c.keys }).length > 0;
      if (c.superset) {
        expect(collides).toBe(false);
        expect(reported).toBe(true);
      } else {
        expect(reported).toBe(collides);
      }
    });
  }
});

describe("declared keys", () => {
  // A key object with no columns, or a collation for a column outside the
  // key, is a declaration mistake; reading past it would check nothing.
  it("refuses a key with no columns or a stray collation", () => {
    expect(() => checkDataSeed("", { t: [{ columns: [] }] })).toThrow(
      /needs its columns/,
    );
    expect(() =>
      checkDataSeed("", { t: [{ columns: ["a"], collate: { b: "NOCASE" } }] }),
    ).toThrow(/collation for b/);
  });

  // Two constraints on one column under different collations each hold
  // their own values; a row is not a repeat of itself under the second.
  it("keeps the claims of keys that differ only in collation apart", () => {
    expect(
      rules("INSERT OR IGNORE INTO t (id, code) VALUES (1, 'usd');", {
        t: [
          "id",
          { columns: ["code"], collate: { code: "NOCASE" } },
          { columns: ["code"], collate: { code: "RTRIM" } },
        ],
      }),
    ).toEqual([]);
  });

  // A real that a TEXT column would render with fewer digits than it was
  // written with is reported however it is spelled.
  it("reports a real with more than 15 significant digits, not one with 15", () => {
    const one = (v: string) =>
      rules(`INSERT OR IGNORE INTO t (id) VALUES (${v});`, { t: ["id"] });
    expect(one("1.2345678901234567")).toEqual(["duplicate-authored-identity"]);
    expect(one("123456789012345.0000")).toEqual([]);
    expect(one("-9223372036854775808")).toEqual([]);
    expect(one("9223372036854775807")).toEqual([]);
    expect(one("9223372036854775808")).toEqual(["duplicate-authored-identity"]);
  });

  // NULL in any column of a composite key means the key never conflicts.
  it("fires on NULL in a column of a composite key", () => {
    expect(
      rules("INSERT OR IGNORE INTO t (id, a, b) VALUES (1, 1, NULL);", {
        t: ["id", { columns: ["a", "b"] }],
      }),
    ).toEqual(["duplicate-authored-identity"]);
  });
});
