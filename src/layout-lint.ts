// The table-layout rules: shapes SQLite accepts without complaint that go
// wrong later, read from a schema snapshot. Each rule returns every finding;
// which of them are audited exceptions is the allowlist's question.

import type { Finding } from "./allowlist";
import type { SchemaSnapshot } from "./schema";
import { isWord, upperAscii } from "./sql-text";
import {
  declaresPrimaryKeyDesc,
  hasLengthCheck,
  readTableSql,
  writesOnDelete,
  type TableDefinition,
} from "./table-sql";

export type LayoutRule =
  | "strict-required"
  | "blob-pk-or-unique-needs-check-length"
  | "fk-type-matches-parent"
  | "fk-explicit-on-delete"
  | "integer-pk-needs-autoincrement-on-fk-target"
  | "fk-needs-lead-index";

export type LayoutFinding = Finding<LayoutRule>;

// The table's CREATE text as definitions, or null when sqlite_master holds
// none this reader can split; a rule that needs the text then finds no
// clause in it, and reports.
function definitionOf(
  snapshot: SchemaSnapshot,
  table: string,
): TableDefinition | null {
  return readTableSql(snapshot.tableSql.get(table) ?? "");
}

function columnsOf(snapshot: SchemaSnapshot, table: string) {
  return snapshot.columns.get(table) ?? [];
}

function foreignKeysOf(snapshot: SchemaSnapshot, table: string) {
  return snapshot.foreignKeys.get(table) ?? [];
}

function indexesOf(snapshot: SchemaSnapshot, table: string) {
  return snapshot.indexes.get(table) ?? [];
}

// Without STRICT, a declared column type is advisory: an INTEGER column
// accepts TEXT, and the stored shape drifts at runtime with nothing failing.
export function strictRequired(snapshot: SchemaSnapshot): LayoutFinding[] {
  return snapshot.tables
    .filter((t) => !t.strict)
    .map((t) => ({
      rule: "strict-required",
      table: t.name,
      detail: "table is not declared STRICT",
    }));
}

// A BLOB key with no length CHECK accepts truncated or padded bytes from a
// producer bug, and every later lookup by the correct value misses. A BLOB
// that is only a foreign key is exempt, the PRIMARY KEY + FOREIGN KEY case
// included: the parent's CHECK is the source of truth, and a second copy on
// the child can drift from it.
export function blobPkOrUniqueNeedsCheckLength(
  snapshot: SchemaSnapshot,
): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  for (const t of snapshot.tables) {
    const def = definitionOf(snapshot, t.name);
    const fkCols = new Set(foreignKeysOf(snapshot, t.name).map((f) => f.from));
    const uniqueCols = new Set<string>();
    for (const idx of indexesOf(snapshot, t.name)) {
      if (idx.unique !== 1) continue;
      const cs = snapshot.indexColumns.get(idx.name) ?? [];
      if (cs.length !== 1) continue;
      const col = cs[0]?.name;
      if (col) uniqueCols.add(col);
    }
    for (const c of columnsOf(snapshot, t.name)) {
      if (c.type !== "BLOB") continue;
      if (fkCols.has(c.name)) continue;
      if (c.pk === 0 && !uniqueCols.has(c.name)) continue;
      if (!def || !hasLengthCheck(def, c.name)) {
        findings.push({
          rule: "blob-pk-or-unique-needs-check-length",
          table: t.name,
          column: c.name,
          detail: "BLOB PK/UNIQUE column lacks CHECK (length(col) = N)",
        });
      }
    }
  }
  return findings;
}

// SQLite does not require a foreign key's type to match its parent's. A
// mismatch coerces at every join, which can keep the planner off the parent's
// index and hides what the child column actually stores.
export function fkTypeMatchesParent(snapshot: SchemaSnapshot): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  for (const t of snapshot.tables) {
    const cols = columnsOf(snapshot, t.name);
    for (const fk of foreignKeysOf(snapshot, t.name)) {
      const childCol = cols.find((c) => c.name === fk.from);
      if (!childCol) continue;
      const parentCols = snapshot.columns.get(fk.table);
      if (!parentCols) continue;
      const parentColName =
        fk.to || parentCols.find((c) => c.pk > 0)?.name || parentCols[0]?.name;
      const parentCol = parentCols.find((c) => c.name === parentColName);
      if (!parentCol) continue;
      if (childCol.type !== parentCol.type) {
        findings.push({
          rule: "fk-type-matches-parent",
          table: t.name,
          column: fk.from,
          detail:
            `FK column type ${childCol.type} does not match parent ` +
            `${fk.table}.${parentCol.name} type ${parentCol.type}`,
        });
      }
    }
  }
  return findings;
}

// A foreign key's delete behavior should be a written decision. The pragma
// reports an omitted ON DELETE and an explicit NO ACTION identically, so this
// reads the CREATE text for the clause: in the column's own definition, or
// in a FOREIGN KEY constraint naming the column. NO ACTION can be right (a
// parent that is never deleted), and writing it down is what says so.
export function fkExplicitOnDelete(snapshot: SchemaSnapshot): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  for (const t of snapshot.tables) {
    const def = definitionOf(snapshot, t.name);
    for (const fk of foreignKeysOf(snapshot, t.name)) {
      if (!def || !writesOnDelete(def, fk.from, fk.table)) {
        findings.push({
          rule: "fk-explicit-on-delete",
          table: t.name,
          column: fk.from,
          detail:
            `FK to ${fk.table}(${fk.to || "rowid"}) lacks explicit ` +
            "ON DELETE clause",
        });
      }
    }
  }
  return findings;
}

// Without AUTOINCREMENT, SQLite may reuse the largest freed rowid on the next
// insert, so a child row still holding the old id silently belongs to the new
// parent. AUTOINCREMENT keeps ids monotonic through sqlite_sequence.
//
// That has a cost a writer must plan for. An insert ATTEMPT reserves the next
// id - a durable sqlite_sequence write, which D1 bills as a row written -
// before SQLite can detect a UNIQUE conflict, so neither an ON CONFLICT arm
// nor INSERT OR IGNORE avoids it, and `changes = 0` does not mean nothing was
// written. A writer that re-attempts an insert on a hot path should gate its
// SELECT on NOT EXISTS of the row it would conflict with, keeping the conflict
// arm as the backstop for concurrent writers.
export function integerPkNeedsAutoincrementOnFkTarget(
  snapshot: SchemaSnapshot,
): LayoutFinding[] {
  const fkTargets = new Set<string>();
  for (const t of snapshot.tables) {
    for (const fk of foreignKeysOf(snapshot, t.name)) fkTargets.add(fk.table);
  }
  const findings: LayoutFinding[] = [];
  for (const t of snapshot.tables) {
    if (!fkTargets.has(t.name)) continue;
    const pkCols = columnsOf(snapshot, t.name).filter((c) => c.pk > 0);
    if (pkCols.length !== 1) continue;
    const pk = pkCols[0]!;
    if (upperAscii(pk.type) !== "INTEGER") continue;
    const def = definitionOf(snapshot, t.name);
    // Only a rowid alias can reuse a freed id, and only it may carry
    // AUTOINCREMENT: not the key of a WITHOUT ROWID table, nor one declared
    // `PRIMARY KEY DESC` in its column, which SQLite does not alias.
    if (def?.withoutRowid || (def && declaresPrimaryKeyDesc(def, pk.name))) {
      continue;
    }
    // SQLite allows AUTOINCREMENT on an INTEGER PRIMARY KEY only, so the word
    // anywhere in this single-key table's text is that key's.
    if (!def?.tokens.some((tok) => isWord(tok, "AUTOINCREMENT"))) {
      findings.push({
        rule: "integer-pk-needs-autoincrement-on-fk-target",
        table: t.name,
        detail:
          `INTEGER PRIMARY KEY ${pk.name} on FK-target table lacks ` +
          "AUTOINCREMENT - rowid reuse can re-link stale FKs",
      });
    }
  }
  return findings;
}

// SQLite does not index a foreign key column for you. Without an index that
// leads with it, every delete or key update on the parent scans the child for
// the constraint check (and the cascade), and every join by the key scans too.
// The column's own primary key counts, as does any index whose FIRST column it
// is; a later position in a compound index cannot be sought into.
export function fkNeedsLeadIndex(snapshot: SchemaSnapshot): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  for (const t of snapshot.tables) {
    const cols = columnsOf(snapshot, t.name);
    const indexes = indexesOf(snapshot, t.name);
    for (const fk of foreignKeysOf(snapshot, t.name)) {
      const col = cols.find((c) => c.name === fk.from);
      if (!col) continue;
      if (col.pk > 0) continue;
      const hasLeadIndex = indexes.some(
        (idx) => snapshot.indexColumns.get(idx.name)?.[0]?.name === fk.from,
      );
      if (!hasLeadIndex) {
        findings.push({
          rule: "fk-needs-lead-index",
          table: t.name,
          column: fk.from,
          detail:
            `FK ${fk.from} -> ${fk.table}(${fk.to || "rowid"}) has no ` +
            `lead-position index - D1 SQLite does not auto-index FK columns; ` +
            `cascade DELETE on the parent and joins by this FK will tablescan`,
        });
      }
    }
  }
  return findings;
}

// Every layout rule's findings, in the order the rules are declared above.
export function lintSchemaLayout(snapshot: SchemaSnapshot): LayoutFinding[] {
  return [
    ...strictRequired(snapshot),
    ...blobPkOrUniqueNeedsCheckLength(snapshot),
    ...fkTypeMatchesParent(snapshot),
    ...fkExplicitOnDelete(snapshot),
    ...integerPkNeedsAutoincrementOnFkTarget(snapshot),
    ...fkNeedsLeadIndex(snapshot),
  ];
}
