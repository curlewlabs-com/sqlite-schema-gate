# sqlite-schema-gate

## What it is

A TypeScript library of checks for a SQLite or
[Cloudflare D1](https://developers.cloudflare.com/d1/) schema and the SQL that
changes it:

- **A table-layout lint.** Read the applied schema through SQLite's pragmas and
  report the shapes SQLite accepts without complaint that go wrong later: a
  table without `STRICT`, a foreign key whose type differs from its parent's or
  that no index leads with, and four more (see [The rules](#the-rules)).
- **A migration lint.** Read a forward migration and the schema it runs against,
  and report the statements that destroy rows or change what existing writes
  mean while the migrated schema still looks exactly as intended: dropping a
  table that parents an `ON DELETE CASCADE` foreign key, a `DELETE` with no
  `WHERE`, a trigger, a generated column.
- **A seed fence.** For a reference-data file applied on every deploy, outside
  the versioned migrations: allow nothing but `INSERT OR IGNORE` of literal rows
  into tables you name, and report a row that collides with one the file already
  wrote.
- **An allowlist** for the layout findings, where every entry carries a reason
  and an entry that no longer suppresses anything is reported.

It has no runtime dependencies. The layout lint reads the database through an
interface D1's `D1Database` already satisfies; the migration lint and the seed
fence read SQL text.

## Why it exists

A schema check usually compares the schema a migration produced with the one
that was expected. Each hazard here passes that comparison:

- **A table rebuild empties its children.** The usual way to change a column in
  SQLite is to create a copy of the table, copy the rows, drop the original and
  rename the copy. When foreign keys are enforced and cannot be switched off
  first (inside a transaction, or on D1, which enforces them in every
  migration), dropping the original runs an implicit `DELETE`, and every
  `ON DELETE CASCADE` child loses its rows. `PRAGMA defer_foreign_keys` does not
  prevent it: it defers constraint checks, not cascade actions. The schema
  afterwards is exactly right and the child tables are empty. Renaming the
  parent aside and dropping it under the new name does the same, because a
  rename rewrites the children's foreign keys to follow it.
- **A trigger or a generated column changes what writes mean.** Every write
  keeps succeeding; what it does, or what a stored row means, changes. A schema
  comparison that reads tables and indexes does not see a trigger, and the
  expected schema carries the same generated column.
- **A seed file that is not idempotent.** A file applied on every deploy is
  safe only while applying it again changes nothing. An `INSERT OR REPLACE`, an
  upsert tail on `INSERT OR IGNORE` (which SQLite accepts), or a `DELETE`
  overwrites live data on every deploy. A row whose primary key repeats an
  earlier row's is dropped by `OR IGNORE` and never lands, and an expected set
  built by running the same file drops it too and agrees with itself.
- **SQLite is permissive about layout.** Declared types are advisory without
  `STRICT`; a foreign key's type need not match its parent's; foreign key
  columns are not indexed for you, so a delete on the parent scans the child;
  and an `INTEGER PRIMARY KEY` without `AUTOINCREMENT` may reuse a deleted id
  that a child row still holds.

Migration linters exist for PostgreSQL and MySQL. For SQLite, the ones we found
flag every `DROP TABLE` alike, or read the schema without the cascade
relationships, and none fences a re-applied seed file. This package reads the
schema the migration runs against, so it flags the drops that cascade and stays
quiet on the ones that do not.

## How to use it

The package is `@curlewlabs-com/sqlite-schema-gate`. It is not on the npm
registry: install it from the GitHub release tarball, with an exact pin:

```sh
bun add https://github.com/curlewlabs-com/sqlite-schema-gate/releases/download/v0.1.1/curlewlabs-com-sqlite-schema-gate-0.1.1.tgz
```

The package ships TypeScript sources; Vitest, Wrangler and Bun compile them.

### The table-layout lint, in a test

Apply your schema to a test database, read it, lint it, and subtract your
audited exceptions. On D1, in a test under `@cloudflare/vitest-plugin`:

```ts
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  applyAllowlist,
  formatEntries,
  formatFindings,
  lintSchemaLayout,
  readSchema,
  type AllowlistEntry,
} from "@curlewlabs-com/sqlite-schema-gate";

const ALLOWLIST: AllowlistEntry[] = [
  {
    rule: "fk-explicit-on-delete",
    table: "orders",
    column: "currency_id",
    reason:
      "currencies is a fixed reference table that is never deleted from; " +
      "the implicit NO ACTION is the intent",
  },
];

it("the schema's layout has no unaudited finding", async () => {
  // ...apply your schema to env.DB first...
  const findings = lintSchemaLayout(await readSchema(env.DB));
  const { remaining, unused } = applyAllowlist(findings, ALLOWLIST);
  expect(remaining, formatFindings(remaining)).toEqual([]);
  expect(
    unused,
    `entries that suppress nothing:\n${formatEntries(unused)}`,
  ).toEqual([]);
});
```

An entry must name the `rule` and the `table`. It may also name a `column`, an
`index` or a `q` (a statement's name); a field it leaves out matches any value,
so an entry with no `column` covers every column of that table for that rule.
`reason` is required, and `applyAllowlist` throws on a blank one. `unused` lists
the entries that suppressed none of the findings passed in. Such an entry looks
like an audited exception and would quietly absorb whatever later matches it,
so remove it or re-confirm it. Read `unused` from one call that is given every
finding the allowlist covers.

The finding shape is the one
[d1-query-plan-gate](https://github.com/curlewlabs-com/d1-query-plan-gate)'s plan
lint reports, so one allowlist can hold the exceptions for both packages, and
for rules of your own written over the same `readSchema` snapshot: a finding is
a plain `{ rule, table, column?, index?, q?, detail }` object.

`readSchema` takes any object with D1's `prepare(sql).all()` and
`batch(statements)` shape. It reads every table in `main` except SQLite's own
(`sqlite_*`) and D1's (`_cf_*`).

### The migration lint, over your files

```ts
// check-migration.ts: bun check-migration.ts <migration.sql> <schema-before.sql>
import { readFileSync } from "node:fs";
import { checkDataLoss } from "@curlewlabs-com/sqlite-schema-gate";

const [migration, schemaBefore] = process.argv.slice(2);
const findings = checkDataLoss(
  readFileSync(migration!, "utf8"),
  readFileSync(schemaBefore!, "utf8"),
);
for (const f of findings) console.error(`[${f.rule}] ${f.message}`);
process.exit(findings.length === 0 ? 0 : 1);
```

The second file is the schema the migration runs against: the `CREATE`
statements of the database before it. A dump of that database's schema
(`sqlite3 app.db .schema`, or
`wrangler d1 export <db> --remote --no-data --output schema-before.sql`) is
exact.
Earlier migration files concatenated in order are not a substitute: a parent
renamed by one of them is still named by its old name in that text, so a later
drop of it under the new name would be missed.

There is no override, marker or comment that silences a finding. A migration
that really needs to drop a cascade parent, delete every row or add a trigger
is a one-off for a person to sign off, not something a comment should wave
through. Run the lint in CI on every migration, so that such a migration
reaches a person.

### The seed fence, over your file

```ts
// check-seed.ts: bun check-seed.ts <seed.sql>
import { readFileSync } from "node:fs";
import {
  checkDataSeed,
  type SeedTables,
} from "@curlewlabs-com/sqlite-schema-gate";

// Each seed table and the columns SQLite treats as its identity: its primary
// key and every UNIQUE column.
const SEED_TABLES: SeedTables = {
  currencies: ["id", "iso_code"],
  tax_rates: ["id", "starts_at"],
};

const findings = checkDataSeed(
  readFileSync(process.argv[2]!, "utf8"),
  SEED_TABLES,
);
for (const f of findings) console.error(`[${f.rule}] ${f.message}`);
process.exit(findings.length === 0 ? 0 : 1);
```

A statement passes only if it is
`INSERT OR IGNORE INTO <table> (<columns>) VALUES (<literals>), ...` into one of
the named tables. The column list is required, and each value is a number,
`NULL` or a quoted string. Everything else is a finding, as is a row that
repeats an identity column's value from an earlier row in the file, leaves an
identity column out, or gives one `NULL`, which SQLite never reads as a
conflict. Name only tables where appending a row is inert for everything that
already read the table. A table whose rows decide behavior does not belong in a
file that converges silently on every deploy.

Each entry in a table's list is one key its rows are unique on. A column's
name is a single-column key compared under SQLite's default `BINARY`
collation: the primary key, or a `UNIQUE` column. A composite `UNIQUE (a, b)`,
or a key column declared with another collation, takes the object form:

```ts
const SEED_TABLES: SeedTables = {
  currencies: [
    "id",
    { columns: ["iso_code"], collate: { iso_code: "NOCASE" } },
  ],
  tax_rates: ["id", { columns: ["region", "starts_at"] }],
};
```

Values compare as SQLite's uniqueness compares them: numbers by value, and
strings under the key column's collation. A number that is not an integer
within 64 bits, written with more than 15 significant digits or too large for
a double, is reported: a `TEXT` column can render such a value as the text of
another (with 15 digits in some SQLite releases, or as `Inf`), so whether it
repeats one depends on the column's type. Write it with at most 15 significant
digits, or as a string.

The fence does not read your schema, so the keys you name are a declaration.
Hold them to the schema with a test that reads `pragma_index_list`,
`pragma_index_xinfo` and `pragma_table_info` for each seed table.
`checkDataSeed` throws on a table named with no keys, or a key with no columns:
with nothing for `OR IGNORE` to conflict on, its rows are inserted again on
every apply.

## The rules

| Lint      | Rule id                                       | Reports                                                                                                                                                                          |
| --------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| layout    | `strict-required`                             | a table not declared `STRICT`                                                                                                                                                    |
| layout    | `blob-pk-or-unique-needs-check-length`        | a `BLOB` primary key or single-column `UNIQUE` with no `CHECK (length(col) = N)`; a foreign key to another column with that check, whose other columns are `NOT NULL`, is exempt |
| layout    | `fk-type-matches-parent`                      | a foreign key column whose declared type differs from the parent column's                                                                                                        |
| layout    | `fk-explicit-on-delete`                       | a foreign key with no `ON DELETE` clause; write `ON DELETE NO ACTION` when that is the intent                                                                                    |
| layout    | `integer-pk-needs-autoincrement-on-fk-target` | an `INTEGER PRIMARY KEY` without `AUTOINCREMENT` on a table some foreign key references                                                                                          |
| layout    | `fk-needs-lead-index`                         | a foreign key none of whose columns is the primary key's first or leads an index the constraint check can use                                                                    |
| migration | `cascade-parent-wipe`                         | `DROP TABLE` of a table that parents an `ON DELETE CASCADE` foreign key declared before the migration or earlier in it, directly or after a rename                               |
| migration | `unscoped-delete`                             | a `DELETE` with no `WHERE` of its own (a CTE's `WHERE` does not count)                                                                                                           |
| migration | `unparseable-target`                          | a `DROP TABLE` or `DELETE` whose target does not parse                                                                                                                           |
| migration | `trigger-semantics`                           | `CREATE TRIGGER` or `DROP TRIGGER`                                                                                                                                               |
| migration | `generated-column-semantics`                  | a generated column in `CREATE TABLE` or `ALTER TABLE`                                                                                                                            |
| seed      | `not-insert-or-ignore`                        | a statement that is not `INSERT OR IGNORE INTO <bare table> (<columns>) ...`                                                                                                     |
| seed      | `table-not-allowlisted`                       | a row for a table not among the seed tables                                                                                                                                      |
| seed      | `non-literal-rows`                            | anything after the column list other than literal `VALUES` tuples: a `SELECT`, an expression, `ON CONFLICT`, `RETURNING`                                                         |
| seed      | `duplicate-authored-identity`                 | a row that repeats an identity value an earlier row in the file used, gives an identity column `NULL`, or omits one                                                              |

`AUTOINCREMENT` has a cost a writer should plan for. An insert attempt reserves
the next id, a durable write to `sqlite_sequence` that D1 bills as a row
written, before SQLite detects a `UNIQUE` conflict. So neither `ON CONFLICT` nor
`INSERT OR IGNORE` avoids it, and `changes = 0` does not mean nothing was
written. A writer that re-attempts an insert on a hot path should guard its
`SELECT` with `NOT EXISTS` of the row it would conflict with.

## Limits

- **The layout reader is tested on D1 in the Workers test runtime only.** Any
  object with the same `prepare`/`all`/`batch` shape will run, such as a few
  lines over another SQLite driver, but nothing else is tested.
- **Three layout rules read the table's `CREATE` text:** the length `CHECK`,
  the `ON DELETE` clause and `AUTOINCREMENT`. The length check is read only in
  the form `CHECK (length(col) = N)`; a check written another way, such as
  `CHECK (N = length(col))` or inside a longer expression, is not seen, and
  the rule reports it.
- **`fk-type-matches-parent` compares declared type names as text**, so `INT`
  and `INTEGER` differ even where SQLite gives them the same affinity.
- **`fk-needs-lead-index` counts an index by its lead column only.** A partial
  index counts whatever its `WHERE`, and an index whose `COLLATE` differs from
  the one the parent key compares under counts too, though either can leave
  the constraint check scanning. Judging a `WHERE` needs an expression parser
  this package does not have, and a wrong judgment would pass a scan.
- **The migration lint reads text, not a database.** It does not cover
  `ALTER TABLE ... DROP COLUMN` (a wrong result shows in the schema),
  `REPLACE` / `INSERT OR REPLACE` (row-level and deliberate), `DROP VIEW` or
  `DROP INDEX`. Dropping a `UNIQUE` index loosens which writes are accepted,
  which this lint leaves to review.
- **A cascade key is never retired.** It still counts after the table holding
  it is dropped, so a migration that drops every cascading child and then the
  parent is reported. Retiring a key exactly would mean following savepoints,
  rollbacks and which schema each name resolves to, and a key retired wrongly
  lets a real wipe pass. A renamed parent also keeps its key under the old
  name, since with `PRAGMA legacy_alter_table` on and foreign keys off SQLite
  does not rewrite the children. A `DROP TABLE` or `DELETE` whose target is a
  single-quoted string is reported as unparseable.
- **The seed fence admits a bare table name only.** A quoted or
  schema-qualified table (`"t"`, `main.t`) is reported.
- **The seed fence does not read column types.** A string that reads as a
  number is compared as that number, which is how SQLite's affinity compares
  `1` and `'1'` in an `INTEGER`, `REAL`, `NUMERIC` or `TEXT` column. A
  `TEXT` column keeps `'01'` and `'1'` apart, a `BLOB` or untyped one keeps
  `1` and `'1'` apart, and an `INTEGER` one keeps apart two integers past
  2^53 that a `REAL` column would round to one value. The fence reports each
  such pair as one row: a false finding, never a missed one.
- **An allowlist entry is keyed by rule, table and the fields it names**, not by
  the relationship it was written about. An entry for a foreign key column keeps
  suppressing its finding after the key is pointed at another parent, so
  re-read the reasons on a table whose keys change.
- Version 0.x carries no compatibility promise between minor versions.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

### Contribution

By submitting a contribution for inclusion in this project, you agree that it
is dual licensed as above, without any additional terms or conditions.
