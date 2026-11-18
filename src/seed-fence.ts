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
//   Whitespace and case ........... keywordView trims, collapses runs and uppercases first.
//   String-content false positives  keywordView blanks '...' before any test, so a literal
//                                   value is never read as grammar.
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
//                                   names each table's identity columns (its primary key and
//                                   every UNIQUE column) so this can be checked.
//   Same value, different form .... identityKey reads a number through Number, so `08` and `8`
//                                   are one identity, as in SQLite.
//   Escaped quotes ................ a string holding '' ('it''s') fails the tail grammar, which
//                                   reads it as two literals, so such a row is a finding.
//   Omitted identity column ....... the column list is required, and a row that leaves an
//                                   identity column to a DEFAULT this fence cannot evaluate is a
//                                   finding, not a skip.
//   NULL identity value ........... a finding for the same reason: SQLite never reads NULL as a
//                                   conflict, so the database, not the file, decides the row's
//                                   identity in that column.

import { excerpt, keywordView, tokenizeStatements } from "./sql-text";

// The tables a seed row may go into, each mapped to the columns SQLite treats
// as its identity: the primary key and every UNIQUE column. A table belongs
// here only if appending a row to it is inert for everything that already
// read it; a table whose rows decide behavior does not.
export type SeedTables = Readonly<Record<string, readonly string[]>>;

export type DataSeedRule =
  | "not-insert-or-ignore"
  | "table-not-allowlisted"
  | "non-literal-rows"
  | "duplicate-authored-identity";

export interface DataSeedFinding {
  rule: DataSeedRule;
  message: string;
}

// The one permitted statement shape, split at the column list so the head and
// the row source are checked separately; each half is a whitelist.
//
// The table is a bare word only: a quoted or schema-qualified target does not
// match and is a finding, without a second identifier parser.
// The column list is REQUIRED: without it the identity columns have no
// position in the tuple and the collision rule could not run, so a positional
// `INSERT OR IGNORE INTO t VALUES (...)` is a finding.
const INSERT_HEAD_RE =
  /^INSERT OR IGNORE INTO ([A-Za-z_]\w*) \(([A-Z_0-9, ]+)\) (.+)$/;
// Everything after the column list must be literal tuples and nothing else:
//
//   ON CONFLICT DO UPDATE. SQLite accepts it after INSERT OR IGNORE and it
//   rewrites the live row, which in a file applied on every deploy is a silent
//   overwrite on every deploy - the hazard OR IGNORE exists to prevent.
//   A SELECT row source, or any expression. What lands then depends on the
//   database it runs against, so the file's text no longer says what it adds.
//   RETURNING, and whatever clause SQLite adds next. A denylist over a growing
//   grammar would fall behind it.
//
// A literal is what a lookup row holds: a number, NULL, or the `''` keywordView
// leaves where a quoted string was.
const LITERAL = String.raw`(?:-?\d+(?:\.\d+)?|''|NULL)`;
const TUPLE = String.raw`\(\s*${LITERAL}(?:\s*,\s*${LITERAL})*\s*\)`;
const VALUES_TAIL_RE = new RegExp(
  String.raw`^VALUES\s*${TUPLE}(?:\s*,\s*${TUPLE})*$`,
);

// The contents of each TOP-LEVEL `(...)` group in a statement, quote-aware. On
// a statement the grammar above has accepted, group 0 is the column list and
// the rest are the value tuples; the tail holds literals only, so nothing
// nests. Reads the RAW text, because the keyword view blanks every quoted
// string to `''`, which is exactly what a TEXT identity is made of - comparing
// blanks would call every text identity a duplicate of every other.
function parenGroups(raw: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuote) {
      buf += ch;
      // A doubled quote is an escaped quote and stays inside the string.
      if (ch === "'" && raw[i + 1] === "'") {
        buf += "'";
        i++;
      } else if (ch === "'") {
        inQuote = false;
      }
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      buf += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (depth === 1) buf = "";
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) groups.push(buf);
      continue;
    }
    if (depth > 0) buf += ch;
  }
  return groups;
}

// Split one group on its top-level commas, with the same quote awareness.
function splitFields(group: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < group.length; i++) {
    const ch = group[i];
    if (inQuote) {
      buf += ch;
      if (ch === "'" && group[i + 1] === "'") {
        buf += "'";
        i++;
      } else if (ch === "'") {
        inQuote = false;
      }
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((f) => f.trim());
}

// Compare authored values the way SQLite's uniqueness would. A quoted string
// compares by its unescaped content; anything else (a number, NULL) by its
// canonical text, so `08` and `8` are one identity.
function identityKey(field: string): string {
  if (field.startsWith("'") && field.endsWith("'") && field.length >= 2) {
    return `s:${field.slice(1, -1).replace(/''/g, "'")}`;
  }
  const numeric = Number(field);
  return Number.isFinite(numeric) ? `n:${numeric}` : `k:${field.toUpperCase()}`;
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
    Object.entries(tables).map(([table, columns]) => [
      table.toLowerCase(),
      columns.map((c) => c.toLowerCase()),
    ]),
  );
  const findings: DataSeedFinding[] = [];
  // Identity values already claimed by an earlier row, keyed
  // `<table>.<column>`, across the whole file: the collision is with any row
  // authored before this one, wherever it was written.
  const claimed = new Map<string, Set<string>>();

  for (const raw of tokenizeStatements(seedSql)) {
    const kw = keywordView(raw);
    const match = INSERT_HEAD_RE.exec(kw);
    if (!match) {
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

    const table = (match[1] as string).toLowerCase();
    const identityColumns = identityByTable.get(table);
    if (!identityColumns) {
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

    if (!VALUES_TAIL_RE.test(match[3] as string)) {
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

    // Only after the grammar above has accepted the statement, so the groups
    // are a column list followed by literal-only tuples, and nothing nests.
    const groups = parenGroups(raw);
    const columns = splitFields(groups[0] as string).map((c) =>
      c.toLowerCase(),
    );
    for (const tuple of groups.slice(1)) {
      const values = splitFields(tuple);
      for (const column of identityColumns) {
        const at = columns.indexOf(column);
        // An omitted column takes its DEFAULT, which this fence cannot
        // evaluate, so the row's identity is unknown here and cannot be
        // cleared.
        if (at === -1 || values[at] === undefined) {
          findings.push({
            rule: "duplicate-authored-identity",
            message:
              `${excerpt(raw)} does not give a value for \`${table}.${column}\`, one of the ` +
              `columns SQLite treats as this table's identity. Without it the row's identity ` +
              `is decided by a DEFAULT this fence cannot evaluate, so it cannot be proved ` +
              `distinct from the rows already written above it.`,
          });
          continue;
        }
        // NULL never conflicts: an INTEGER PRIMARY KEY given NULL takes a new
        // rowid, and a UNIQUE column holds any number of NULLs. Such a value
        // is an identity the database picks, as an omitted one is, and where
        // it is the row's only identity the row is added on every apply.
        if (/^NULL$/i.test(values[at])) {
          findings.push({
            rule: "duplicate-authored-identity",
            message:
              `${excerpt(raw)} gives \`${table}.${column}\` the value NULL, one of the ` +
              `columns SQLite treats as this table's identity. NULL never conflicts: an ` +
              `INTEGER PRIMARY KEY given NULL takes a new rowid, and a UNIQUE column holds ` +
              `any number of NULLs. So \`OR IGNORE\` cannot recognize the row by this column ` +
              `on the next apply, and a row with no other identity is added again on every ` +
              `apply. Write the identity value.`,
          });
          continue;
        }
        const key = `${table}.${column}`;
        const seen = claimed.get(key) ?? new Set<string>();
        const value = identityKey(values[at]);
        if (seen.has(value)) {
          findings.push({
            rule: "duplicate-authored-identity",
            message:
              `${excerpt(raw)} reuses \`${table}.${column}\` = ${values[at]}, which an earlier ` +
              `row in this file already claims. \`INSERT OR IGNORE\` DROPS it - silently, on ` +
              `every database that already has the earlier row - so the new row never lands. ` +
              `An expected set built by running this same file drops it too and agrees with ` +
              `itself. Give the row its own identity.`,
          });
        }
        seen.add(value);
        claimed.set(key, seen);
      }
    }
  }

  return findings;
}
