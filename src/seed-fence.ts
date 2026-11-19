// The seed fence: a shape check for a reference-data file that is applied on
// every deploy, outside the versioned migrations, and so must change nothing
// the second time it runs.
//
// The file's whole safety argument is that re-applying it is a no-op: it holds
// nothing but INSERT OR IGNORE of literal rows into a named set of lookup
// tables, so running it twice, or against a database that already has the
// rows, changes nothing. That argument is only as good as this fence. Without
// it the file is unversioned SQL a deploy executes verbatim - the easiest
// place to hide DDL, a DELETE or an UPDATE that would never get past the
// migration lint.
//
// So this is a WHITELIST: a statement passes only if it has the one permitted
// shape against a named table. Every other statement, and every fragment that
// does not parse, is a finding. There is no marker or override; anything else
// belongs in a versioned migration.
//
// Where a hazard could still wear the permitted shape, and how each is met:
//   Statement splitting ........... tokenizeStatements (sql-text.ts), which handles quoting,
//                                   comments and `;` inside literals.
//   Whitespace, case and quoting .. each statement is read as sqlTokens (sql-text.ts) cuts it,
//                                   so keywords match in any case and spacing, and a string's
//                                   content, escaped quotes included, is a value, never grammar.
//   Quoted or qualified tables .... the head admits a bare word only, so "t", `t`, [t] and
//                                   main.t are findings rather than being resolved.
//   Conflict-clause aliases ....... OR REPLACE / ABORT / FAIL / ROLLBACK and bare REPLACE INTO
//                                   all miss the one permitted opening. OR REPLACE also
//                                   survives a re-run, so "is it idempotent" is not the test -
//                                   the exact opening is.
//   Upsert tail ................... SQLite ACCEPTS `INSERT OR IGNORE ... ON CONFLICT DO UPDATE`,
//                                   and it rewrites the live row: the hazard that wears the
//                                   permitted opening. The tail is whitelisted to literal tuples
//                                   rather than denying that clause, so RETURNING and whatever
//                                   SQLite adds next are covered too.
//   Row sources ................... SELECT, DEFAULT VALUES and any expression (`unixepoch('now')`)
//                                   fail the tuple grammar.
//   Table existence ............... not checked: this file never reads the schema. A row for a
//                                   table the schema lacks fails when the file is applied.
//   Identity collisions ........... a row whose identity an EARLIER row in the file already
//                                   claims is dropped by OR IGNORE on every database that has
//                                   the earlier row, and an expected set built by running the
//                                   same file drops it too and agrees with itself. The caller
//                                   names each table's keys (its primary key and every UNIQUE
//                                   constraint, composite ones whole) so this can be checked.
//   Same value, different form .... identityKey compares numbers by value as doubles, so `08`,
//                                   `8` and `8.0` are one identity, as in SQLite. A string that
//                                   reads as a number is that number: SQLite's column affinity
//                                   makes `1` and `'1'` one value in an INTEGER, REAL, NUMERIC
//                                   or TEXT column. Where a column's type keeps such a pair
//                                   apart - `1` and `'1'` in a BLOB or untyped column, `'01'`
//                                   and `'1'` in TEXT, two integers past 2^53 that share a
//                                   double in INTEGER - reporting it is a false finding, never a
//                                   missed one, since the fence does not read column types. A
//                                   real with more than 15 significant digits, or too large for
//                                   a double, is a finding: a TEXT column may render it, by
//                                   SQLite release, with 15 digits, the same as another value,
//                                   or as 'Inf'.
//   Collation ..................... a string compares under the collation its key column
//                                   declares, BINARY unless the key says NOCASE or RTRIM, as the
//                                   UNIQUE index compares it.
//   Composite keys ................ a key of several columns collides only when every column
//                                   does, so rows of a UNIQUE (a, b) that share `a` are distinct.
//   Omitted identity column ....... the column list is required, and a row that leaves an
//                                   identity column to a DEFAULT this fence cannot evaluate is a
//                                   finding, not a skip.
//   NULL identity value ........... a finding for the same reason: SQLite never reads NULL as a
//                                   conflict, so the database, not the file, decides the row's
//                                   identity in that column.

import {
  excerpt,
  foldName,
  isWord,
  sqlTokens,
  tokenizeStatements,
  type Token,
} from "./sql-text";

// The collations SQLite builds in. NOCASE folds ASCII letters only, and RTRIM
// ignores trailing spaces.
export type SeedCollation = "BINARY" | "NOCASE" | "RTRIM";

// One key a seed table's rows are unique on. A plain column name is a
// single-column key compared under BINARY, the default: the primary key, or a
// UNIQUE column. The object form names a key's columns, several for a
// composite UNIQUE (a, b), and the collation of each column that does not
// compare under BINARY.
export type SeedKey =
  | string
  | {
      readonly columns: readonly string[];
      readonly collate?: Readonly<Record<string, SeedCollation>>;
    };

// The tables a seed row may go into, each mapped to the keys SQLite treats as
// its identity: the primary key and every UNIQUE constraint. A table belongs
// here only if appending a row to it is inert for everything that already
// read it; a table whose rows decide behavior does not.
export type SeedTables = Readonly<Record<string, readonly SeedKey[]>>;

// A key as the fence compares it: folded column names, the collation of each,
// and its name in a message.
interface Key {
  columns: string[];
  collations: SeedCollation[];
  label: string;
}

function toKey(table: string, key: SeedKey): Key {
  if (typeof key === "string") {
    const column = foldName(key);
    return { columns: [column], collations: ["BINARY"], label: column };
  }
  const columns = key.columns.map(foldName);
  const collate = new Map(
    Object.entries(key.collate ?? {}).map(([c, v]) => [foldName(c), v]),
  );
  const stray = [...collate.keys()].filter((c) => !columns.includes(c));
  if (columns.length === 0 || stray.length > 0) {
    throw new Error(
      `sqlite-schema-gate: a key of seed table ${table} needs its columns, and ` +
        `a collation only for one of them; got columns [${key.columns.join(", ")}]` +
        (stray.length > 0 ? ` and a collation for ${stray.join(", ")}` : ""),
    );
  }
  const [first] = columns;
  return {
    columns,
    collations: columns.map((c) => collate.get(c) ?? "BINARY"),
    label:
      columns.length === 1 && first !== undefined
        ? first
        : `(${columns.join(", ")})`,
  };
}

export type DataSeedRule =
  | "not-insert-or-ignore"
  | "table-not-allowlisted"
  | "non-literal-rows"
  | "duplicate-authored-identity";

export interface DataSeedFinding {
  rule: DataSeedRule;
  message: string;
}

// The one permitted head, `INSERT OR IGNORE INTO <table> (<column>, ...)`,
// with something after it; null for any other.
//
// The table is a bare word only: a quoted or schema-qualified target does not
// match and is a finding, without a second identifier parser.
// The column list is REQUIRED: without it the identity columns have no
// position in the tuple and the collision rule could not run, so a positional
// `INSERT OR IGNORE INTO t VALUES (...)` is a finding.
function readHead(
  tokens: Token[],
): { table: string; columns: string[]; at: number } | null {
  const opening = ["INSERT", "OR", "IGNORE", "INTO"];
  if (!opening.every((w, k) => isWord(tokens[k], w))) return null;
  const table = tokens[4];
  if (table?.kind !== "word" || tokens[5]?.text !== "(") return null;
  const columns: string[] = [];
  let k = 6;
  for (;;) {
    const column = tokens[k];
    if (column?.kind !== "word") return null;
    columns.push(foldName(column.text));
    const next = tokens[k + 1]?.text;
    k += 2;
    if (next === ")") break;
    if (next !== ",") return null;
  }
  if (k >= tokens.length) return null;
  return { table: foldName(table.text), columns, at: k };
}

// A literal is what a lookup row holds: a decimal number, optionally
// negative, a quoted string, or NULL.
interface Literal {
  kind: "number" | "string" | "null";
  // As written, for a message.
  text: string;
  value: string;
}

function literalAt(
  tokens: Token[],
  i: number,
): { literal: Literal; end: number } | null {
  const t = tokens[i];
  if (t?.kind === "string") {
    return {
      literal: { kind: "string", text: t.text, value: t.value },
      end: i + 1,
    };
  }
  if (isWord(t, "NULL")) {
    return { literal: { kind: "null", text: "NULL", value: "" }, end: i + 1 };
  }
  const minus = t?.text === "-";
  const n = tokens[minus ? i + 1 : i];
  if (n?.kind === "number" && /^\d+(?:\.\d+)?$/.test(n.text)) {
    const text = minus ? `-${n.text}` : n.text;
    return {
      literal: { kind: "number", text, value: text },
      end: minus ? i + 2 : i + 1,
    };
  }
  return null;
}

// The rows of a tail that is `VALUES (<literal>, ...), ...` and nothing else;
// null for any other. Everything after the column list must be literal tuples:
//
//   ON CONFLICT DO UPDATE. SQLite accepts it after INSERT OR IGNORE and it
//   rewrites the live row, which in a file applied on every deploy is a silent
//   overwrite on every deploy - the hazard OR IGNORE exists to prevent.
//   A SELECT row source, or any expression. What lands then depends on the
//   database it runs against, so the file's text no longer says what it adds.
//   RETURNING, and whatever clause SQLite adds next. A denylist over a growing
//   grammar would fall behind it.
function readRows(tokens: Token[], at: number): Literal[][] | null {
  if (!isWord(tokens[at], "VALUES")) return null;
  const rows: Literal[][] = [];
  let k = at + 1;
  for (;;) {
    if (tokens[k]?.text !== "(") return null;
    k++;
    const row: Literal[] = [];
    for (;;) {
      const read = literalAt(tokens, k);
      if (!read) return null;
      row.push(read.literal);
      const next = tokens[read.end]?.text;
      k = read.end + 1;
      if (next === ")") break;
      if (next !== ",") return null;
    }
    rows.push(row);
    if (k === tokens.length) return rows;
    if (tokens[k]?.text !== ",") return null;
    k++;
  }
}

// A number literal whose comparison does not hang on the column's type: an
// integer within 64 bits, which SQLite stores and renders exactly, or a
// finite real of at most 15 significant digits, which a TEXT column renders
// back to the value it was written as. Any other real can render, in a TEXT
// column, as the same text as a different value: SQLite releases that keep
// 15 significant digits do so, and every release renders an overflow as
// 'Inf'.
const INT64 = 2n ** 63n;
function comparableNumber(text: string): boolean {
  const unsigned = text.replace(/^-/, "");
  if (/^\d+$/.test(unsigned)) {
    const n = BigInt(text);
    if (n >= -INT64 && n < INT64) return true;
  }
  // Significant digits: leading and trailing zeros do not count.
  const all = unsigned.replace(".", "");
  let start = 0;
  let end = all.length;
  while (start < end && all[start] === "0") start++;
  while (end > start && all[end - 1] === "0") end--;
  const digits = all.slice(start, end);
  return digits.length <= 15 && Number.isFinite(Number(text));
}

// A number by its value as a double. Two numbers SQLite holds equal have the
// same double, whatever the column. Two integers past 2^53 that share a
// double are one value in a REAL column and two in an INTEGER one; the fence
// does not read the column's type, so it calls them one.
function numberKey(text: string): string {
  return `n:${Number(text.trim())}`;
}

// The text forms SQLite's affinity converts to a number: a decimal integer
// or real, with optional sign, exponent and surrounding whitespace.
const NUMERIC_TEXT_RE =
  /^[ \t\n\v\f\r]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\v\f\r]*$/;

// RTRIM ignores trailing spaces only, not other whitespace. A loop rather
// than / +$/, which backtracks over every run of spaces not at the end.
function trimTrailingSpaces(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === " ") end--;
  return s.slice(0, end);
}

// Compare authored values the way SQLite's uniqueness would, without the
// column's type: a number by value, and a string by its content under the
// key column's collation, unless it reads as a number, which the column's
// affinity would make it.
function identityKey(literal: Literal, collation: SeedCollation): string {
  if (literal.kind === "string" && !NUMERIC_TEXT_RE.test(literal.value)) {
    if (collation === "NOCASE") return `s:${foldName(literal.value)}`;
    if (collation === "RTRIM") return `s:${trimTrailingSpaces(literal.value)}`;
    return `s:${literal.value}`;
  }
  return numberKey(literal.value);
}

// The row's value of `key`, compared as SQLite would, and as written; null
// when a column of the key is omitted or NULL, after reporting it. Either way
// the key cannot identify the row: an omitted column takes a DEFAULT this
// fence cannot evaluate, and NULL never conflicts - an INTEGER PRIMARY KEY
// given NULL takes a new rowid, and a UNIQUE key holds any number of rows
// with a NULL in it. Where that key is the row's only identity, the row is
// added again on every apply.
function keyIdentity(
  raw: string,
  table: string,
  key: Key,
  columns: string[],
  values: Literal[],
  findings: DataSeedFinding[],
): { value: string; text: string } | null {
  const parts: string[] = [];
  const texts: string[] = [];
  let known = true;
  for (const [k, column] of key.columns.entries()) {
    const at = columns.indexOf(column);
    const value = at === -1 ? undefined : values[at];
    if (value === undefined) {
      findings.push({
        rule: "duplicate-authored-identity",
        message:
          `${excerpt(raw)} does not give a value for \`${table}.${column}\`, one of the ` +
          `columns SQLite treats as this table's identity. Without it the row's identity ` +
          `is decided by a DEFAULT this fence cannot evaluate, so it cannot be proved ` +
          `distinct from the rows already written above it.`,
      });
      known = false;
      continue;
    }
    if (value.kind === "null") {
      findings.push({
        rule: "duplicate-authored-identity",
        message:
          `${excerpt(raw)} gives \`${table}.${column}\` the value NULL, one of the ` +
          `columns SQLite treats as this table's identity. NULL never conflicts: an ` +
          `INTEGER PRIMARY KEY given NULL takes a new rowid, and a UNIQUE key holds ` +
          `any number of rows with a NULL in it. So \`OR IGNORE\` cannot recognize the ` +
          `row by this key on the next apply, and a row with no other identity is ` +
          `added again on every apply. Write the identity value.`,
      });
      known = false;
      continue;
    }
    if (value.kind === "number" && !comparableNumber(value.text)) {
      findings.push({
        rule: "duplicate-authored-identity",
        message:
          `${excerpt(raw)} gives \`${table}.${column}\` the number ${value.text}, which SQLite ` +
          `stores as a REAL that a TEXT column can render as the text of another value ` +
          `(with 15 significant digits in some SQLite releases, or as 'Inf'), so whether ` +
          `it repeats a value written above it depends on the column's type, which this ` +
          `fence does not read. Write it with at most 15 significant digits, or as a ` +
          `string.`,
      });
      known = false;
      continue;
    }
    parts.push(identityKey(value, key.collations[k] ?? "BINARY"));
    texts.push(value.text);
  }
  if (!known) return null;
  const [first] = texts;
  return {
    value: JSON.stringify(parts),
    text:
      texts.length === 1 && first !== undefined
        ? first
        : `(${texts.join(", ")})`,
  };
}

// Every statement in `seedSql` that is not an idempotent literal insert into
// one of `tables`, and every row that collides with an earlier row's identity.
// An empty result means the file is safe to apply again. Table and column
// names compare case-insensitively, as SQLite compares them.
export function checkDataSeed(
  seedSql: string,
  tables: SeedTables,
): DataSeedFinding[] {
  // A table with no identity columns has nothing OR IGNORE can conflict on,
  // so every apply inserts its rows again: an empty list is not a table the
  // fence can call idempotent, and passing its rows would say it was.
  const keyless = Object.entries(tables)
    .filter(([, columns]) => columns.length === 0)
    .map(([table]) => table);
  if (keyless.length > 0) {
    throw new Error(
      "sqlite-schema-gate: every seed table needs its identity columns (its " +
        "primary key and each UNIQUE column); none given for: " +
        keyless.join(", "),
    );
  }
  // A Map rather than the record itself, so a table named like an Object
  // prototype member (`constructor`) is not read as allowlisted.
  const identityByTable = new Map(
    Object.entries(tables).map(([table, keys]) => [
      foldName(table),
      keys.map((key) => toKey(table, key)),
    ]),
  );
  const findings: DataSeedFinding[] = [];
  // Identity values already claimed by an earlier row, keyed
  // `<table>.<key>`, across the whole file: the collision is with any row
  // authored before this one, wherever it was written.
  const claimed = new Map<string, Set<string>>();

  for (const raw of tokenizeStatements(seedSql)) {
    const tokens = sqlTokens(raw);
    const head = readHead(tokens);
    if (!head) {
      findings.push({
        rule: "not-insert-or-ignore",
        message:
          `${excerpt(raw)} is not an \`INSERT OR IGNORE INTO <table> (<columns>) ...\` ` +
          `statement. A seed file applied on every deploy, outside the versioned ` +
          `migrations, must be a no-op the second time it runs. DDL, DELETE, UPDATE and ` +
          `plain INSERT belong in a versioned migration, where the migration lint and the ` +
          `schema it runs against can be checked.`,
      });
      continue;
    }

    const { table, columns } = head;
    const identityKeys = identityByTable.get(table);
    if (!identityKeys) {
      findings.push({
        rule: "table-not-allowlisted",
        message:
          `${excerpt(raw)} targets \`${table}\`, which is not one of the seed tables. ` +
          `Only pure reference tables belong there - adding a row must not change what ` +
          `any deployed client or service does with the rows it already had. Adding a ` +
          `table to the set is a design decision, not a step in landing a row.`,
      });
      continue;
    }

    const rows = readRows(tokens, head.at);
    if (!rows) {
      findings.push({
        rule: "non-literal-rows",
        message:
          `${excerpt(raw)} does not end in a literal \`VALUES (...)\` list and nothing ` +
          `else. An upsert tail (\`ON CONFLICT ... DO UPDATE\`, which SQLite accepts on ` +
          `an INSERT OR IGNORE) rewrites the live row on every deploy, and any non-literal ` +
          `row source makes what lands depend on the database rather than on this file's ` +
          `text.`,
      });
      continue;
    }

    for (const values of rows) {
      for (const key of identityKeys) {
        const identity = keyIdentity(
          raw,
          table,
          key,
          columns,
          values,
          findings,
        );
        if (identity === null) continue;
        // By columns and collations: two keys on one column under different
        // collations are two constraints, each with its own claims.
        const claim = JSON.stringify([table, key.columns, key.collations]);
        const seen = claimed.get(claim) ?? new Set<string>();
        if (seen.has(identity.value)) {
          findings.push({
            rule: "duplicate-authored-identity",
            message:
              `${excerpt(raw)} reuses \`${table}.${key.label}\` = ${identity.text}, which an ` +
              `earlier row in this file already claims. \`INSERT OR IGNORE\` DROPS it - silently, ` +
              `on every database that already has the earlier row - so the new row never ` +
              `lands. An expected set built by running this same file drops it too and agrees ` +
              `with itself. Give the row its own identity.`,
          });
        }
        seen.add(identity.value);
        claimed.set(claim, seen);
      }
    }
  }

  return findings;
}
