// The table-layout rules: shapes SQLite accepts without complaint that go
// wrong later, read from a schema snapshot. Each rule returns every finding;
// which of them are audited exceptions is the allowlist's question.

import type { Finding } from "./allowlist";
import type { SchemaSnapshot } from "./schema";

export type LayoutRule =
  | "strict-required"
  | "blob-pk-or-unique-needs-check-length"
  | "fk-type-matches-parent"
  | "fk-explicit-on-delete"
  | "integer-pk-needs-autoincrement-on-fk-target"
  | "fk-needs-lead-index";

export type LayoutFinding = Finding<LayoutRule>;

// Identifiers are spliced into patterns over the table's CREATE text, so a
// name carrying a pattern character must match only itself.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const sql = snapshot.tableSql.get(t.name) ?? "";
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
      const lengthCheck = new RegExp(
        `CHECK\\s*\\(\\s*length\\s*\\(\\s*${escapeRegExp(c.name)}\\s*\\)\\s*=\\s*\\d+\\s*\\)`,
        "i",
      );
      if (!lengthCheck.test(sql)) {
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
// reads the CREATE text for the clause. NO ACTION can be right (a parent that
// is never deleted), and writing it down is what says so.
export function fkExplicitOnDelete(snapshot: SchemaSnapshot): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  for (const t of snapshot.tables) {
    const sql = snapshot.tableSql.get(t.name) ?? "";
    for (const fk of foreignKeysOf(snapshot, t.name)) {
      const from = escapeRegExp(fk.from);
      const parent = escapeRegExp(fk.table);
      // The column form, `<from> ... REFERENCES <parent>(...) ... ON DELETE`,
      // and the table form, `FOREIGN KEY (<from>) REFERENCES ... ON DELETE`.
      // Each needs ON DELETE before the comma or parenthesis that ends the
      // column or constraint.
      const colLevel = new RegExp(
        `\\b${from}\\b[^,()]*REFERENCES\\s+${parent}\\b[^,]*ON\\s+DELETE\\b`,
        "i",
      );
      const tableLevel = new RegExp(
        `FOREIGN\\s+KEY\\s*\\([^)]*\\b${from}\\b[^)]*\\)\\s*REFERENCES\\s+${parent}\\b[^,]*ON\\s+DELETE\\b`,
        "i",
      );
      if (!colLevel.test(sql) && !tableLevel.test(sql)) {
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
    if (pk.type !== "INTEGER") continue;
    const sql = snapshot.tableSql.get(t.name) ?? "";
    const autoinc = new RegExp(
      `\\b${escapeRegExp(pk.name)}\\b\\s+INTEGER\\s+PRIMARY\\s+KEY\\s+AUTOINCREMENT\\b`,
      "i",
    );
    if (!autoinc.test(sql)) {
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
