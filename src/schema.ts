// Reads an applied schema into a plain snapshot: every user table, its
// columns, foreign keys and indexes as SQLite's pragmas report them, and the
// CREATE text sqlite_master keeps for the syntax no pragma exposes. The layout
// rules read only the snapshot, so they never touch a database, and a caller's
// own rules can read the same object.

import type { SchemaDatabase } from "./database";

export interface UserTable {
  name: string;
  strict: boolean;
}

// One column as pragma_table_xinfo reports it, generated columns included.
// `pk` is the column's 1-based position in the primary key, 0 when it is not
// part of one.
export interface ColumnInfo {
  name: string;
  type: string;
  not_null: number;
  dflt_value: string | null;
  pk: number;
}

// One row of pragma_foreign_key_list. A multi-column key is several rows
// sharing `id`, ordered by `seq`. `to` is null when the key names no parent
// column, which SQLite resolves to the parent's primary key.
export interface ForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_delete: string;
  on_update: string;
}

// One row of pragma_index_list. `origin` is "c" for CREATE INDEX, "u" for a
// UNIQUE constraint and "pk" for a PRIMARY KEY's own index.
export interface IndexInfo {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

// One row of pragma_index_info. `name` is null for an expression key.
export interface IndexColumn {
  seqno: number;
  cid: number;
  name: string | null;
}

export interface IndexSqlRow {
  name: string;
  tbl_name: string;
  // null for an index SQLite creates itself (a UNIQUE or PRIMARY KEY's).
  sql: string | null;
}

export interface SchemaSnapshot {
  tables: UserTable[];
  columns: Map<string, ColumnInfo[]>;
  foreignKeys: Map<string, ForeignKey[]>;
  indexes: Map<string, IndexInfo[]>;
  indexColumns: Map<string, IndexColumn[]>;
  tableSql: Map<string, string>;
  indexSql: IndexSqlRow[];
}

// sqlite_* tables belong to SQLite and _cf_* ones to D1; neither's shape is
// the schema author's to change.
const SYSTEM_TABLE_PREFIXES = ["sqlite_", "_cf_"];

function isSystemTable(name: string): boolean {
  return SYSTEM_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// The name is quoted into the SQL rather than bound: D1 accepts a bound
// argument to a pragma table-valued function in a lone statement but refuses
// one inside a batch (SQLITE_AUTH), and accepts a literal in both. Doubling an
// embedded quote keeps a name carrying one from closing the literal early; the
// names come from the database's own catalog.
function pragmaArg(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

// One batch per pragma over the whole name set: a statement per name would
// cost a round trip per table and then per index, a walk whose length the
// schema sets and whose cost a loaded test host multiplies.
async function pragmaByName<T>(
  db: SchemaDatabase,
  names: readonly string[],
  sqlFor: (name: string) => string,
): Promise<Map<string, T[]>> {
  // A schema with no index reaches here with nothing to ask about, and D1
  // refuses an empty batch.
  if (names.length === 0) return new Map();
  const results = await db.batch<T>(
    names.map((name) => db.prepare(sqlFor(name))),
  );
  return new Map(names.map((name, i) => [name, results[i]!.results]));
}

export async function readSchema(db: SchemaDatabase): Promise<SchemaSnapshot> {
  const tableRows = await db
    .prepare(
      `SELECT name, "strict" AS strict FROM pragma_table_list
       WHERE type = 'table' AND schema = 'main'
       ORDER BY name`,
    )
    .all<{ name: string; strict: number }>();
  const tables = tableRows.results
    .filter((row) => !isSystemTable(row.name))
    .map((row) => ({ name: row.name, strict: row.strict === 1 }));
  const tableNames = tables.map((t) => t.name);

  const columns = await pragmaByName<ColumnInfo>(
    db,
    tableNames,
    (table) =>
      // table_xinfo rather than table_info, which leaves generated columns
      // out, and with them every rule a generated column can break. Hidden
      // 1 is a virtual table's hidden column, which no table read here has.
      `SELECT name, type, "notnull" AS not_null, dflt_value, pk
       FROM pragma_table_xinfo(${pragmaArg(table)})
       WHERE hidden <> 1`,
  );
  const foreignKeys = await pragmaByName<ForeignKey>(
    db,
    tableNames,
    (table) =>
      `SELECT id, seq, "table" AS "table", "from" AS "from", "to" AS "to",
              on_delete, on_update
       FROM pragma_foreign_key_list(${pragmaArg(table)})`,
  );
  const indexes = await pragmaByName<IndexInfo>(
    db,
    tableNames,
    (table) =>
      `SELECT name, "unique" AS "unique", origin, partial
       FROM pragma_index_list(${pragmaArg(table)})`,
  );
  const indexColumns = await pragmaByName<IndexColumn>(
    db,
    [...indexes.values()].flat().map((i) => i.name),
    (index) =>
      `SELECT seqno, cid, name FROM pragma_index_info(${pragmaArg(index)})`,
  );

  const tableSqlRows = await db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`,
    )
    .all<{ name: string; sql: string }>();
  const tableSql = new Map<string, string>();
  for (const row of tableSqlRows.results) {
    if (!isSystemTable(row.name)) tableSql.set(row.name, row.sql);
  }

  const indexSqlRows = await db
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'`,
    )
    .all<IndexSqlRow>();
  const indexSql = indexSqlRows.results.filter(
    (row) => !isSystemTable(row.tbl_name),
  );

  return {
    tables,
    columns,
    foreignKeys,
    indexes,
    indexColumns,
    tableSql,
    indexSql,
  };
}
