// The migration safety lint: statements in a forward migration that destroy
// rows, or change what existing writes mean, while the schema the migration
// produces looks exactly as intended. A check that compares the migrated
// schema against the expected one passes on every one of these, which is why
// they need a lint of their own.
//
// It reads two texts: the migration, and the schema the migration runs
// against. It knows nothing about how a migration is applied or scheduled - a
// destructive statement destroys rows in a maintenance window too.
//
// Silent row loss:
//
//   cascade-parent-wipe    Dropping a table that parents an ON DELETE CASCADE
//                          foreign key deletes every child row. The parents
//                          are read from the schema BEFORE the migration,
//                          since the schema after it no longer shows the drop,
//                          and from each CREATE TABLE and ALTER TABLE in the
//                          migration as it is reached, since a child created
//                          and filled earlier in the same migration loses its
//                          rows just the same. A key is never retired: see
//                          "Dropped children" below.
//                          The usual table rebuild (create a copy, copy the
//                          rows, drop the original, rename) does this whenever
//                          foreign keys are enforced and cannot be switched
//                          off first: inside a transaction, or on D1, which
//                          enforces them in every migration. PRAGMA
//                          defer_foreign_keys does not stop it: it defers
//                          constraint checks, not cascade actions.
//   unscoped-delete        A DELETE with no WHERE empties the table.
//   unparseable-target     A destructive statement whose target will not parse
//                          cannot be checked for either, so it is a finding.
//
// Silent change in meaning, with no row lost:
//
//   trigger-semantics      A trigger changes what an existing INSERT, UPDATE or
//                          DELETE does while the write keeps succeeding. A
//                          schema comparison that reads tables and indexes
//                          does not see one.
//   generated-column-      A generated column changes what a stored row means
//   semantics              while writes keep succeeding, and the expected
//                          schema carries the same column.
//
// There is no override, marker or declaration. A migration that really needs
// one of these is a one-off for a person to sign off, not something a comment
// should wave through.
//
// What the parser reads, and what it deliberately does not:
//   Tokens ......................... every statement is read as sqlTokens (sql-text.ts) cuts it,
//                                    as SQLite's tokenizer would, so keywords match whatever
//                                    whitespace, comments or quotes surround them, and a keyword
//                                    inside a string or a quoted name is never read as one:
//                                    DEFAULT 'DROP TABLE x' and "x AS (" are inert.
//   Quoted and qualified names ..... handled - "double", `backtick`, [bracket] and bare names
//                                    holding `$` all resolve to the object, compared with ASCII
//                                    case folded as SQLite compares them; a destructive target
//                                    may be schema-qualified (main.t). A single-quoted name is
//                                    read where only a name can stand (REFERENCES 'p').
//   Dropped children ............... accepted - a key still counts after the table holding it is
//                                    dropped, so dropping every cascading child and then the
//                                    parent is reported. Retiring a key exactly would mean
//                                    following savepoints and rollbacks and which schema each
//                                    name resolves to, and a key retired wrongly lets a real wipe
//                                    pass. A false finding, never a missed one.
//   Minified one-liners ............ handled - the split is by character on `;`, not by line.
//   Multi-line statements .......... handled - same; a foreign key split across lines matches.
//   Statement classes .............. row loss: DROP TABLE and DELETE. Change in meaning:
//                                    CREATE/DROP TRIGGER, plus the statements that can carry a
//                                    column definition (CREATE TABLE, ALTER TABLE), scanned for
//                                    the generated-column grammar `AS (`. A CTE's
//                                    `WITH x AS (...)` and CAST's `AS type` live outside those
//                                    statements and cannot match. Deliberately not covered:
//                                    ALTER ... DROP COLUMN (rewrites rows in place and fires no
//                                    cascade; a wrong result shows in the schema), REPLACE and
//                                    INSERT OR REPLACE (row-level and intentional), DROP VIEW
//                                    (no rows; a view changes what a write means only through an
//                                    INSTEAD OF trigger, which is caught when it is created), and
//                                    DROP INDEX (no rows; a UNIQUE drop loosens which writes are
//                                    accepted, a constraint change this lint leaves to review).
//                                    A destructive statement whose target will not parse is a
//                                    finding. The change-in-meaning rules parse no target at all:
//                                    the statement class alone is the finding, so a malformed
//                                    statement of that class is still one.
//   Trigger bodies ................. tokenizeStatements splits a BEGIN...END body at its inner
//                                    `;`s, but the first fragment still starts with CREATE
//                                    TRIGGER, so the trigger is still found; later fragments can
//                                    only add findings to it.
//   Bracketed whitespace ........... out of scope - SQLite reads `[ x ]` as the name ` x `, which
//                                    cannot name a table created as `x`; such a migration fails
//                                    when it runs rather than slipping past here.

import {
  excerpt,
  foldName,
  isWord,
  sqlTokens,
  tokenizeStatements,
  type Token,
} from "./sql-text";
import { referencesIn } from "./table-sql";

export type DataLossRule =
  | "cascade-parent-wipe"
  | "unscoped-delete"
  | "unparseable-target"
  | "trigger-semantics"
  | "generated-column-semantics";

export interface DataLossFinding {
  rule: DataLossRule;
  message: string;
}

// A name as the lint compares it, folded, and as written, for a message.
interface Name {
  name: string;
  display: string;
}

// One identifier at `tokens[i]`: a bare word or a quoted name, never empty.
// `allowString` admits a single-quoted string too, which SQLite reads as a
// name where only a name can stand (`REFERENCES 'p'`, `CREATE TABLE 'c'`).
function nameAt(tokens: Token[], i: number, allowString = false): Name | null {
  const t = tokens[i];
  if (!t) return null;
  const ok =
    t.kind === "word" ||
    t.kind === "name" ||
    (allowString && t.kind === "string");
  if (!ok || t.value === "") return null;
  return { name: foldName(t.value), display: t.value };
}

// `[schema.]table` at `tokens[i]`, resolved to the table - the object
// touched, not the `main` qualifier - or null when it does not parse: a
// missing or malformed name, a dangling `.`, or more than two parts. A
// destructive statement whose target is null is reported, never skipped.
function tableRefAt(
  tokens: Token[],
  i: number,
  allowString = false,
): { ref: Name; end: number } | null {
  const first = nameAt(tokens, i, allowString);
  if (!first) return null;
  if (tokens[i + 1]?.text !== ".") return { ref: first, end: i + 1 };
  const second = nameAt(tokens, i + 2, allowString);
  if (!second || tokens[i + 3]?.text === ".") return null;
  return { ref: second, end: i + 3 };
}

// The words at `tokens[i..]` match `words` in order.
function wordsAt(tokens: Token[], i: number, ...words: string[]): boolean {
  return words.every((w, k) => isWord(tokens[i + k], w));
}

// Past an optional `TEMP` / `TEMPORARY` at `tokens[i]`.
function skipTemp(tokens: Token[], i: number): number {
  return isWord(tokens[i], "TEMP") || isWord(tokens[i], "TEMPORARY")
    ? i + 1
    : i;
}

// The tables a statement's `REFERENCES <table> ... ON DELETE CASCADE` keys
// name, folded; referencesIn (table-sql.ts) reads each key's clauses.
function cascadeParentsIn(tokens: Token[]): string[] {
  return referencesIn(tokens)
    .filter((r) => r.onDelete === "CASCADE")
    .map((r) => r.parent);
}

// The tables named as the target of a `REFERENCES <table> ... ON DELETE
// CASCADE` foreign key in `schemaSql`, folded and unquoted. Dropping one of
// these deletes its children's rows.
export function findCascadeParents(schemaSql: string): Set<string> {
  const parents = new Set<string>();
  for (const raw of tokenizeStatements(schemaSql)) {
    const tokens = sqlTokens(raw);
    if (!isColumnDefCarrier(tokens)) continue;
    for (const parent of cascadeParentsIn(tokens)) parents.add(parent);
  }
  return parents;
}

// No target is parsed: the statement class alone is the finding, which leaves
// no unparseable case to slip through.
function isTrigger(tokens: Token[]): boolean {
  if (isWord(tokens[0], "DROP")) return isWord(tokens[1], "TRIGGER");
  return (
    isWord(tokens[0], "CREATE") &&
    isWord(tokens[skipTemp(tokens, 1)], "TRIGGER")
  );
}

// The only statements whose grammar can carry a column definition, and so a
// generated column or a foreign key. Scoping the `AS (` scan to them keeps a
// CTE's `WITH x AS (SELECT ...)` and CAST's `AS type` from reading as one.
function isColumnDefCarrier(tokens: Token[]): boolean {
  if (isWord(tokens[0], "ALTER")) return isWord(tokens[1], "TABLE");
  return (
    isWord(tokens[0], "CREATE") && isWord(tokens[skipTemp(tokens, 1)], "TABLE")
  );
}

// Inside a carrier statement, `AS (` appears only in the generated-column
// grammar `[GENERATED ALWAYS] AS (expr)`: CAST's AS takes a bare type name,
// table constraints carry no AS, a column definition or CHECK cannot hold a
// subquery, and `CREATE TABLE ... AS SELECT` is followed by SELECT. One test
// covers the explicit form and the bare shorthand.
function declaresGeneratedColumn(tokens: Token[]): boolean {
  return tokens.some((t, i) => isWord(t, "AS") && tokens[i + 1]?.text === "(");
}

// The DELETE FROM of a statement, at the top level: at its start, or after
// the `)` that closes its last CTE. Inside parentheses it would be another
// statement's text, which SQLite does not allow.
function deleteFromAt(tokens: Token[]): number {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.text === "(") depth++;
    else if (t.text === ")") depth--;
    else if (
      depth === 0 &&
      (i === 0 || tokens[i - 1]?.text === ")") &&
      wordsAt(tokens, i, "DELETE", "FROM")
    ) {
      return i;
    }
  }
  return -1;
}

// A WHERE of the DELETE's own: after its target, outside every parenthesis,
// so neither a CTE's WHERE before it nor a subquery's in RETURNING counts.
function hasTopLevelWhere(tokens: Token[], from: number): boolean {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.text === "(") depth++;
    else if (t.text === ")") depth--;
    else if (depth === 0 && isWord(t, "WHERE")) return true;
  }
  return false;
}

// Every statement in `migrationSql` that destroys rows or changes what writes
// mean, read against `schemaBeforeSql`, the schema the migration runs on. An
// empty result means the migration preserves both.
export function checkDataLoss(
  migrationSql: string,
  schemaBeforeSql: string,
): DataLossFinding[] {
  const findings: DataLossFinding[] = [];
  const cascadeParents = findCascadeParents(schemaBeforeSql);

  // In order, so a rename is seen before a later drop of the renamed table,
  // and a key counts from the statement that declares it on. ALTER TABLE ...
  // RENAME rewrites each child's stored foreign key to follow the new name, so
  // renaming a cascade parent aside and dropping it under the new name
  // cascades exactly as dropping it directly would.
  for (const raw of tokenizeStatements(migrationSql)) {
    const tokens = sqlTokens(raw);

    if (isTrigger(tokens)) {
      findings.push({
        rule: "trigger-semantics",
        message:
          `${excerpt(raw)} creates or drops a trigger. A trigger silently changes what ` +
          `existing writes do - every INSERT/UPDATE/DELETE keeps succeeding while its ` +
          `side effects appear or vanish - and a schema comparison that reads tables ` +
          `and indexes does not see it. Evolve semantics additively (expand, then ` +
          `contract); a migration that really needs a trigger is a one-off for a ` +
          `person to sign off.`,
      });
      continue;
    }

    if (isColumnDefCarrier(tokens)) {
      // No `continue` after a generated-column finding: a pathological ALTER
      // that matches here AND renames a table still owes the rename tracking
      // below, so a later drop of the renamed cascade parent is not missed.
      if (declaresGeneratedColumn(tokens)) {
        findings.push({
          rule: "generated-column-semantics",
          message:
            `${excerpt(raw)} declares a generated column ([GENERATED ALWAYS] AS (expr)). ` +
            `A generated column silently changes what a stored row means - writes from ` +
            `code already deployed keep succeeding while the derived value gives them new ` +
            `meaning - and the expected schema carries the same column, so a schema ` +
            `comparison passes across exactly the change that altered meaning. Store the ` +
            `value as a plain column the application writes, or treat this as a one-off ` +
            `for a person to sign off.`,
        });
      }
      // A cascade relationship this migration creates counts from the
      // statement that creates it on: a rebuild that recreates a child with ON
      // DELETE CASCADE, copies its rows in, and then rebuilds the parent wipes
      // the copied rows, and the schema before the migration shows no such
      // key. ALTER TABLE ... ADD COLUMN can declare one too.
      for (const parent of cascadeParentsIn(tokens)) cascadeParents.add(parent);
    }

    if (isWord(tokens[0], "ALTER")) {
      const table = tableRefAt(tokens, 2, true);
      const at = table ? table.end : -1;
      if (table && wordsAt(tokens, at, "RENAME", "TO")) {
        const to = nameAt(tokens, at + 2, true);
        // The old name stays a parent too: with PRAGMA legacy_alter_table on
        // and foreign keys off, SQLite does not rewrite the children, which
        // then name whatever table takes the old name next.
        if (to && cascadeParents.has(table.ref.name)) {
          cascadeParents.add(to.name);
        }
      }
      continue;
    }

    if (wordsAt(tokens, 0, "DROP", "TABLE")) {
      const at = wordsAt(tokens, 2, "IF", "EXISTS") ? 4 : 2;
      const target = tableRefAt(tokens, at);
      if (!target) {
        findings.push({
          rule: "unparseable-target",
          message:
            `Could not extract the dropped table from ${excerpt(raw)}. A destructive ` +
            `statement whose target will not parse cannot be checked for a cascade wipe - ` +
            `rewrite it with a plain or standard-quoted identifier.`,
        });
        continue;
      }
      const { ref } = target;
      if (cascadeParents.has(ref.name)) {
        findings.push({
          rule: "cascade-parent-wipe",
          message:
            `"${ref.display}" parents an ON DELETE CASCADE foreign key; dropping it deletes ` +
            `every child row, and PRAGMA defer_foreign_keys does not prevent that - it ` +
            `defers constraint checks, not cascade actions. The schema after the migration ` +
            `still looks as intended, so a schema comparison will not notice the rows are ` +
            `gone. Change the table in place (ALTER TABLE ... ADD COLUMN) instead of ` +
            `rebuilding it; a real rewrite of a parent table needs a design of its own.`,
        });
      }
      continue;
    }

    const del = deleteFromAt(tokens);
    if (del !== -1) {
      const target = tableRefAt(tokens, del + 2);
      if (!target) {
        findings.push({
          rule: "unparseable-target",
          message:
            `Could not extract the DELETE target from ${excerpt(raw)}. A destructive ` +
            `statement whose target will not parse cannot be checked for a full-table ` +
            `wipe - rewrite it with a plain or standard-quoted identifier.`,
        });
        continue;
      }
      // WHERE is looked for only AFTER the target. A CTE prefix carries its
      // own WHERE, so testing the whole statement would read
      // `WITH x AS (SELECT ... WHERE ...) DELETE FROM t` as scoped when the
      // DELETE itself empties the table.
      if (!hasTopLevelWhere(tokens, target.end)) {
        findings.push({
          rule: "unscoped-delete",
          message:
            `${excerpt(raw)} deletes every row in "${target.ref.display}" - it carries no WHERE. ` +
            `A forward migration should preserve rows by default. Scope the DELETE, or ` +
            `treat this as a one-off destructive migration for a person to sign off.`,
        });
      }
    }
  }

  return findings;
}
