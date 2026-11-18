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
//                          rows just the same.
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
//   Leading/trailing whitespace .... handled - readComponentAt skips it, keywordView trims.
//   Line and block comments ........ handled - tokenizeStatements strips each to a token boundary.
//   String-content false positives . handled - keywordView blanks '...' literals before any
//                                    keyword test, so DEFAULT 'DROP TABLE x' is inert.
//   Quoted and qualified names ..... handled - "double", `backtick`, [bracket], and
//                                    schema-qualified main.t all resolve to the object.
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
//   Quoted name containing `AS (` .. accepted - keywordView blanks only single-quoted literals,
//                                    so a double-quoted identifier containing `AS (` in a CREATE
//                                    or ALTER TABLE reads as a generated column. A false finding,
//                                    never a missed one.
//   Bracketed whitespace ........... out of scope - SQLite reads `[ x ]` as the name ` x `, which
//                                    cannot name a table created as `x`; such a migration fails
//                                    when it runs rather than slipping past here.

import {
  blankStringLiterals,
  excerpt,
  keywordView,
  tokenizeStatements,
} from "./sql-text";

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

// A SQLite identifier: bare, or quoted "double" / `backtick` / [bracket].
const IDENT_TOKEN = '(?:"(?:[^"]|"")*"|`[^`]*`|\\[[^\\]]*\\]|\\w+)';

function unquoteIdent(s: string): string {
  return s.replace(/["'`[\]]/g, "").toLowerCase();
}

// Read ONE identifier component at or after `start`, skipping leading
// whitespace: a bare word, or one of the quoted forms SQLite accepts, where a
// doubled closing quote inside "" or `` is a literal quote. Returns the
// unquoted component and the index past it, or null when there is none (an
// unterminated quote, or a token that is not an identifier, such as a
// single-quoted string).
function readComponentAt(
  s: string,
  start: number,
): { ident: string; end: number } | null {
  let i = start;
  while (i < s.length && /\s/.test(s[i] as string)) i++;
  if (i >= s.length) return null;
  const open = s[i];
  const close =
    open === "[" ? "]" : open === '"' ? '"' : open === "`" ? "`" : null;
  if (close) {
    i++;
    let out = "";
    while (i < s.length) {
      if (s[i] === close) {
        // A doubled closer (not for []) is an escaped quote and stays in the name.
        if (close !== "]" && s[i + 1] === close) {
          out += close;
          i += 2;
          continue;
        }
        i++;
        return out.length > 0 ? { ident: out, end: i } : null;
      }
      out += s[i];
      i++;
    }
    // Unterminated quote: an opaque target, which the caller reports.
    return null;
  }
  // A bare SQL identifier starts with a letter or underscore, never a digit.
  const m = /^[A-Za-z_]\w*/.exec(s.slice(i));
  return m ? { ident: m[0], end: i + m[0].length } : null;
}

// Resolve a possibly schema-qualified reference (`main.t`) to its LAST
// component - the object actually touched, not the `main` qualifier. A
// trailing `.` with nothing after it is malformed. null means the target did
// not parse and the caller must report it: a plain \w+ match here would
// silently read only the start of a quoted name containing a space, and the
// schema instead of the table of a qualified one.
function readIdentifierAt(
  s: string,
  start: number,
): { ident: string; end: number } | null {
  let comp = readComponentAt(s, start);
  if (!comp) return null;
  let i = comp.end;
  for (;;) {
    let k = i;
    while (k < s.length && /\s/.test(s[k] as string)) k++;
    if (s[k] !== ".") break;
    comp = readComponentAt(s, k + 1);
    if (!comp) return null;
    i = comp.end;
  }
  return { ident: comp.ident, end: i };
}

// The tables named as the target of a `REFERENCES <table> ... ON DELETE
// CASCADE` foreign key in `schemaSql`, lowercased and unquoted. Dropping one
// of these deletes its children's rows.
export function findCascadeParents(schemaSql: string): Set<string> {
  const parents = new Set<string>();
  // The referenced table and its trailing ON clauses, skipping any column
  // list. The `\s*` sits INSIDE the optional column-list group so that, for a
  // key with no column list - `REFERENCES parent ON DELETE CASCADE` - the space
  // before `ON` is not consumed, which would leave the ON-clause group empty.
  const re = new RegExp(
    `REFERENCES\\s+(${IDENT_TOKEN})(?:\\s*\\([^)]*\\))?((?:\\s+ON\\s+(?:DELETE|UPDATE)\\s+(?:NO\\s+ACTION|SET\\s+(?:NULL|DEFAULT)|CASCADE|RESTRICT))*)`,
    "gi",
  );
  // Statements, not raw text, so a REFERENCES ... ON DELETE CASCADE written in
  // a comment cannot register a parent that does not exist; and string
  // literals blanked, so neither can a `DEFAULT 'REFERENCES p ON DELETE
  // CASCADE'`.
  for (const statement of tokenizeStatements(schemaSql)) {
    const ddl = blankStringLiterals(statement);
    let m: RegExpExecArray | null;
    while ((m = re.exec(ddl)) !== null) {
      const table = m[1];
      const clauses = m[2] ?? "";
      if (table && /ON\s+DELETE\s+CASCADE/i.test(clauses)) {
        parents.add(unquoteIdent(table));
      }
    }
  }
  return parents;
}

const DROP_TABLE_RE = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?/i;
const RENAME_RE = /^ALTER\s+TABLE\s+/i;
// A DELETE may follow one or more CTEs. Anchoring on `^DELETE` alone would let
// `WITH doomed AS (...) DELETE FROM t` past every check below.
const DELETE_RE = /(?:^|\)\s*)DELETE\s+FROM\s+/i;
// No target is parsed: the statement class alone is the finding, which leaves
// no unparseable case to slip through.
const TRIGGER_RE = /^(?:CREATE\s+(?:TEMP(?:ORARY)?\s+)?|DROP\s+)TRIGGER\b/i;
// The only statements whose grammar can carry a column definition, and so a
// generated column. Scoping the `AS (` scan to them keeps a CTE's
// `WITH x AS (SELECT ...)` and CAST's `AS type` from reading as one.
const COLUMN_DEF_CARRIER_RE =
  /^(?:CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE|ALTER\s+TABLE)\b/i;
// Inside a carrier statement, `AS (` appears only in the generated-column
// grammar `[GENERATED ALWAYS] AS (expr)`: CAST's AS takes a bare type name,
// table constraints carry no AS, and a column definition or CHECK cannot hold
// a subquery. One pattern covers the explicit form and the bare shorthand.
const GENERATED_COLUMN_RE = /\bAS\s*\(/i;

// Every statement in `migrationSql` that destroys rows or changes what writes
// mean, read against `schemaBeforeSql`, the schema the migration runs on. An
// empty result means the migration preserves both.
export function checkDataLoss(
  migrationSql: string,
  schemaBeforeSql: string,
): DataLossFinding[] {
  const findings: DataLossFinding[] = [];
  const cascadeParents = findCascadeParents(schemaBeforeSql);

  // In order, so a rename is seen before a later drop of the renamed table.
  // ALTER TABLE ... RENAME rewrites each child's stored foreign key to follow
  // the new name, so renaming a cascade parent aside and dropping it under the
  // new name cascades exactly as dropping it directly would.
  for (const raw of tokenizeStatements(migrationSql)) {
    const kw = keywordView(raw);

    if (TRIGGER_RE.test(kw)) {
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

    // No `continue` after a generated-column finding: a pathological ALTER that
    // matches here AND renames a table still owes the rename tracking below,
    // so a later drop of the renamed cascade parent is not missed.
    if (COLUMN_DEF_CARRIER_RE.test(kw) && GENERATED_COLUMN_RE.test(kw)) {
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

    // A cascade relationship this migration creates counts from the statement
    // that creates it on: a rebuild that recreates a child with ON DELETE
    // CASCADE, copies its rows in, and then rebuilds the parent wipes the
    // copied rows, and the schema before the migration shows no such key.
    // ALTER TABLE ... ADD COLUMN can declare one too.
    if (COLUMN_DEF_CARRIER_RE.test(kw)) {
      for (const parent of findCascadeParents(raw)) cascadeParents.add(parent);
    }

    if (RENAME_RE.test(kw)) {
      // Offsets from `raw`, never a fallback of 0: reading from 0 would take
      // ALTER itself as the table name and drop the alias without a word.
      const alter = RENAME_RE.exec(raw);
      // One whitespace character on each side, not a run: an unanchored leading
      // run makes the search quadratic in a long stretch of spaces, and the
      // identifier reader skips whitespace either way.
      const renameTo = /\sRENAME\s+TO\s/i.exec(raw);
      if (alter && renameTo) {
        const from = readIdentifierAt(raw, alter[0].length);
        const to = readIdentifierAt(raw, renameTo.index + renameTo[0].length);
        if (from && to && cascadeParents.has(unquoteIdent(from.ident))) {
          cascadeParents.add(unquoteIdent(to.ident));
        }
      }
      continue;
    }

    if (DROP_TABLE_RE.test(kw)) {
      const m = DROP_TABLE_RE.exec(raw);
      const target = m ? readIdentifierAt(raw, m[0].length) : null;
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
      const name = unquoteIdent(target.ident);
      if (cascadeParents.has(name)) {
        findings.push({
          rule: "cascade-parent-wipe",
          message:
            `"${target.ident}" parents an ON DELETE CASCADE foreign key; dropping it deletes ` +
            `every child row, and PRAGMA defer_foreign_keys does not prevent that - it ` +
            `defers constraint checks, not cascade actions. The schema after the migration ` +
            `still looks as intended, so a schema comparison will not notice the rows are ` +
            `gone. Change the table in place (ALTER TABLE ... ADD COLUMN) instead of ` +
            `rebuilding it; a real rewrite of a parent table needs a design of its own.`,
        });
      }
      continue;
    }

    const del = DELETE_RE.exec(kw);
    if (del) {
      // The target is found again in `raw`: blanking a literal in the keyword
      // view changes offsets after it, so an offset from one is not one in the
      // other.
      const rawDel = DELETE_RE.exec(raw);
      const target = rawDel
        ? readIdentifierAt(raw, rawDel.index + rawDel[0].length)
        : null;
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
      const afterTarget = raw.slice(target.end);
      if (!/\bWHERE\b/i.test(afterTarget)) {
        findings.push({
          rule: "unscoped-delete",
          message:
            `${excerpt(raw)} deletes every row in "${target.ident}" - it carries no WHERE. ` +
            `A forward migration should preserve rows by default. Scope the DELETE, or ` +
            `treat this as a one-off destructive migration for a person to sign off.`,
        });
      }
    }
  }

  return findings;
}
