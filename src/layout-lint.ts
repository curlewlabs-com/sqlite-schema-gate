// The table-layout rules: shapes SQLite accepts without complaint that go
// wrong later, read from a schema snapshot. Each rule returns every finding;
// which of them are audited exceptions is the allowlist's question.

import type { Finding } from "./allowlist";
import type { ColumnInfo, ForeignKey, SchemaSnapshot } from "./schema";
import { foldName, isWord, upperAscii } from "./sql-text";
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

// A table as a foreign key names it, which need not be the case the table
// was declared in: SQLite matches the names with ASCII case folded.
function tableNamed(snapshot: SchemaSnapshot, name: string): string | null {
  const folded = foldName(name);
  return snapshot.tables.find((t) => foldName(t.name) === folded)?.name ?? null;
}

function columnNamed(
  columns: readonly ColumnInfo[],
  name: string,
): ColumnInfo | undefined {
  const folded = foldName(name);
  return columns.find((c) => foldName(c.name) === folded);
}

// The parent column one row of a foreign key points at: the column it
// names, or, when it names none, the parent's primary key column at the same
// position as this row's column in the key.
function parentColumnOf(
  snapshot: SchemaSnapshot,
  fk: ForeignKey,
): { table: string; column: ColumnInfo } | null {
  const table = tableNamed(snapshot, fk.table);
  if (table === null) return null;
  const cols = columnsOf(snapshot, table);
  const column =
    fk.to !== null
      ? columnNamed(cols, fk.to)
      : cols.find((c) => c.pk === fk.seq + 1);
  return column ? { table, column } : null;
}

// The table's single INTEGER PRIMARY KEY column, when it is an alias of the
// rowid: not the key of a WITHOUT ROWID table, nor one declared `PRIMARY KEY
// DESC` in its column, which SQLite does not alias. Such a column never holds
// NULL, whatever pragma_table_info reports for it: a NULL inserted there
// becomes a new rowid.
function rowidAlias(
  snapshot: SchemaSnapshot,
  table: string,
): ColumnInfo | null {
  const pkCols = columnsOf(snapshot, table).filter((c) => c.pk > 0);
  const [pk] = pkCols;
  if (pkCols.length !== 1 || pk === undefined) return null;
  if (upperAscii(pk.type) !== "INTEGER") return null;
  const def = definitionOf(snapshot, table);
  if (def?.withoutRowid || (def && declaresPrimaryKeyDesc(def, pk.name))) {
    return null;
  }
  return pk;
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
// that is a foreign key is exempt, the PRIMARY KEY + FOREIGN KEY case
// included, when a column it references carries the CHECK and the key is
// checked whenever this column has a value: that is the source of truth,
// and a second copy on the child can drift from it. A key whose parents
// carry none, that references only itself, or that has another column that
// may be NULL, has no check to defer to.
export function blobPkOrUniqueNeedsCheckLength(
  snapshot: SchemaSnapshot,
): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  for (const t of snapshot.tables) {
    const def = definitionOf(snapshot, t.name);
    // A row's value of a foreign key column must equal its parent column's,
    // so one reference to a column whose length is checked checks this one
    // too - unless it is the column itself, or the key has another column
    // that may be NULL: SQLite does not check a composite key any of whose
    // columns is NULL.
    const fks = foreignKeysOf(snapshot, t.name);
    const cols = columnsOf(snapshot, t.name);
    const governed = (column: string) =>
      fks.some((fk) => {
        if (foldName(fk.from) !== foldName(column)) return false;
        const parent = parentColumnOf(snapshot, fk);
        if (!parent) return false;
        const self =
          parent.table === t.name &&
          foldName(parent.column.name) === foldName(column);
        const alias = rowidAlias(snapshot, t.name);
        const companionsSet = fks
          .filter((o) => o.id === fk.id && o.seq !== fk.seq)
          .every((o) => {
            const c = columnNamed(cols, o.from);
            return c?.not_null === 1 || (c !== undefined && c === alias);
          });
        const parentDef = definitionOf(snapshot, parent.table);
        return (
          !self &&
          companionsSet &&
          parentDef !== null &&
          hasLengthCheck(parentDef, parent.column.name)
        );
      });
    const uniqueCols = new Set<string>();
    for (const idx of indexesOf(snapshot, t.name)) {
      if (idx.unique !== 1) continue;
      const cs = snapshot.indexColumns.get(idx.name) ?? [];
      if (cs.length !== 1) continue;
      const col = cs[0]?.name;
      if (col) uniqueCols.add(col);
    }
    for (const c of columnsOf(snapshot, t.name)) {
      if (upperAscii(c.type) !== "BLOB") continue;
      if (governed(c.name)) continue;
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
      const childCol = columnNamed(cols, fk.from);
      if (!childCol) continue;
      const parent = parentColumnOf(snapshot, fk);
      if (!parent) continue;
      const parentCol = parent.column;
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
    for (const fk of foreignKeysOf(snapshot, t.name)) {
      const target = tableNamed(snapshot, fk.table);
      if (target !== null) fkTargets.add(target);
    }
  }
  const findings: LayoutFinding[] = [];
  for (const t of snapshot.tables) {
    if (!fkTargets.has(t.name)) continue;
    // Only a rowid alias can reuse a freed id, and only it may carry
    // AUTOINCREMENT.
    const pk = rowidAlias(snapshot, t.name);
    if (!pk) continue;
    const def = definitionOf(snapshot, t.name);
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
// The primary key counts when the column is its FIRST column, as does any
// index whose first column it is; a later position in a compound key or
// index cannot be sought into.
export function fkNeedsLeadIndex(snapshot: SchemaSnapshot): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  for (const t of snapshot.tables) {
    const cols = columnsOf(snapshot, t.name);
    const indexes = indexesOf(snapshot, t.name);
    // One foreign key is all the rows sharing its id. Its check looks the
    // child up by every one of its columns at once, so an index that leads
    // with any of them can serve it.
    const byId = new Map<number, [ForeignKey, ...ForeignKey[]]>();
    for (const fk of foreignKeysOf(snapshot, t.name)) {
      const prior = byId.get(fk.id);
      byId.set(fk.id, prior === undefined ? [fk] : [...prior, fk]);
    }
    for (const rows of byId.values()) {
      rows.sort((x, y) => x.seq - y.seq);
      const keyCols = rows
        .map((fk) => columnNamed(cols, fk.from))
        .filter((c): c is ColumnInfo => c !== undefined);
      if (keyCols.length !== rows.length) continue;
      const inKey = (name: string) =>
        keyCols.some((c) => foldName(c.name) === foldName(name));
      // Only the primary key's first column can be sought into. A partial
      // index counts whatever its WHERE (README, Limits).
      if (keyCols.some((c) => c.pk === 1)) continue;
      const hasLeadIndex = indexes.some((idx) => {
        const lead = snapshot.indexColumns.get(idx.name)?.[0]?.name;
        return lead != null && inKey(lead);
      });
      if (!hasLeadIndex) {
        const first = rows[0];
        const from = rows.map((fk) => fk.from).join(", ");
        const to = rows.map((fk) => fk.to || "rowid").join(", ");
        findings.push({
          rule: "fk-needs-lead-index",
          table: t.name,
          column: first.from,
          detail:
            `FK ${from} -> ${first.table}(${to}) has no ` +
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
