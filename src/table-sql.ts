// Reading the text of a CREATE TABLE, as sqlite_master keeps it, or of an
// ALTER TABLE ... ADD COLUMN, for the syntax no pragma reports: each foreign
// key's written ON DELETE clause, a length CHECK, AUTOINCREMENT, a column's
// PRIMARY KEY DESC and WITHOUT ROWID. Both the layout rules and the
// migration lint read it here.
//
// It reads tokens (sql-text.ts), so a string default or a quoted name that
// spells one of those clauses is never read as it, and a quoted name is
// compared by its content with ASCII case folded, as SQLite compares it.

import {
  foldName,
  isWord,
  sqlTokens,
  upperAscii,
  type Token,
} from "./sql-text";

// A name token's folded content, or null for any other token. `allowString`
// admits a single-quoted string too, which SQLite reads as a name where only
// a name can stand (`REFERENCES 'p'`).
export function nameOf(
  token: Token | undefined,
  allowString = false,
): string | null {
  if (!token || token.value === "") return null;
  const ok =
    token.kind === "word" ||
    token.kind === "name" ||
    (allowString && token.kind === "string");
  return ok ? foldName(token.value) : null;
}

// One `REFERENCES <parent> ...` in a statement's tokens: the parent, folded,
// and the action of its last ON DELETE clause, or null when it writes none.
//
// A key's clauses are not parsed one by one: SQLite accepts MATCH, ON INSERT,
// ON UPDATE and ON DELETE in any order and number, followed by other column
// constraints, and a reader that stopped at one it did not know would drop
// a clause written after it. Instead the key's extent runs to the `,` or `)`
// that ends its column definition or table constraint, or to the next
// REFERENCES, and its last ON DELETE decides, as a later clause of a kind
// replaces an earlier one in SQLite. Nothing else in a column definition or
// a table constraint holds the words ON DELETE. test/fk-grammar.test.ts
// holds every form of the grammar against SQLite's own reading of it.
export interface Reference {
  at: number;
  parent: string;
  onDelete: string | null;
}

export function referencesIn(tokens: Token[]): Reference[] {
  const out: Reference[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], "REFERENCES")) continue;
    const parent = nameOf(tokens[i + 1], true);
    if (parent === null) continue;
    let depth = 0;
    let onDelete: string | null = null;
    for (let k = i + 2; k < tokens.length; k++) {
      const t = tokens[k] as Token;
      if (t.text === "(") depth++;
      if (t.text === ")") depth--;
      if (depth < 0) break;
      if (depth === 0 && (t.text === "," || isWord(t, "REFERENCES"))) break;
      if (isWord(t, "ON") && isWord(tokens[k + 1], "DELETE")) {
        onDelete = upperAscii(tokens[k + 2]?.text ?? "");
      }
    }
    out.push({ at: i, parent, onDelete });
  }
  return out;
}

export interface TableDefinition {
  tokens: Token[];
  // Each column definition, by its folded name, as the tokens after the name.
  columns: Map<string, Token[]>;
  // Each table constraint's tokens.
  constraints: Token[][];
  withoutRowid: boolean;
}

// The words a table constraint can start with; anything else starts a
// column definition.
const CONSTRAINT_START = [
  "CONSTRAINT",
  "PRIMARY",
  "UNIQUE",
  "CHECK",
  "FOREIGN",
];

function startsConstraint(token: Token): boolean {
  return CONSTRAINT_START.some((w) => isWord(token, w));
}

// SQLite lets table constraints follow one another with no comma between
// them (parse.y: `tconscomma ::= COMMA | .`), so one comma-separated part
// can hold several. A new one starts at each constraint keyword outside
// parentheses, except the one right after `CONSTRAINT <name>`, which is
// that constraint's own.
function splitConstraints(part: Token[]): Token[][] {
  const out: Token[][] = [];
  let depth = 0;
  for (const t of part) {
    const current = out[out.length - 1];
    const named = current?.length === 2 && isWord(current[0], "CONSTRAINT");
    if (!current || (depth === 0 && startsConstraint(t) && !named)) {
      out.push([t]);
    } else {
      current.push(t);
    }
    if (t.text === "(") depth++;
    if (t.text === ")") depth--;
  }
  return out;
}

// `sql` as a definition, or null when it is not a CREATE TABLE with a column
// list (a CREATE TABLE ... AS SELECT has none).
export function readTableSql(sql: string): TableDefinition | null {
  const tokens = sqlTokens(sql);
  const open = tokens.findIndex((t) => t.text === "(");
  if (open === -1 || !isWord(tokens[0], "CREATE")) return null;
  const parts: Token[][] = [[]];
  let depth = 0;
  let close = -1;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.text === ")" && depth === 0) {
      close = i;
      break;
    }
    if (t.text === "(") depth++;
    if (t.text === ")") depth--;
    if (depth === 0 && t.text === ",") parts.push([]);
    else (parts[parts.length - 1] as Token[]).push(t);
  }
  if (close === -1) return null;
  const columns = new Map<string, Token[]>();
  const constraints: Token[][] = [];
  for (const part of parts) {
    const first = part[0];
    if (!first) continue;
    if (startsConstraint(first)) {
      constraints.push(...splitConstraints(part));
      continue;
    }
    const name = nameOf(first, true);
    if (name !== null) columns.set(name, part.slice(1));
  }
  const options = tokens.slice(close + 1);
  const withoutRowid = options.some(
    (t, i) => isWord(t, "WITHOUT") && isWord(options[i + 1], "ROWID"),
  );
  return { tokens, columns, constraints, withoutRowid };
}

// The table carries `CHECK (length(<column>) = <N>)`, as a column or a table
// constraint.
export function hasLengthCheck(def: TableDefinition, column: string): boolean {
  const t = def.tokens;
  const col = foldName(column);
  for (let i = 0; i < t.length; i++) {
    if (!isWord(t[i], "CHECK") || t[i + 1]?.text !== "(") continue;
    if (!isWord(t[i + 2], "LENGTH") || t[i + 3]?.text !== "(") continue;
    if (nameOf(t[i + 4]) !== col || t[i + 5]?.text !== ")") continue;
    if (t[i + 6]?.text !== "=") continue;
    const n = t[i + 7]?.text === "=" ? i + 8 : i + 7;
    if (t[n]?.kind === "number" && t[n + 1]?.text === ")") return true;
  }
  return false;
}

// Every foreign key from `column` to `parent` writes an ON DELETE clause,
// in the column's definition or in a table constraint naming the column.
// Every one, so that of two keys over the same pair, the one with no clause
// is not covered by the other's.
export function writesOnDelete(
  def: TableDefinition,
  column: string,
  parent: string,
): boolean {
  const col = foldName(column);
  const target = foldName(parent);
  const keys = referencesIn(def.columns.get(col) ?? []).filter(
    (r) => r.parent === target,
  );
  for (const c of def.constraints) {
    const fk = c.findIndex(
      (t, i) => isWord(t, "FOREIGN") && isWord(c[i + 1], "KEY"),
    );
    if (fk === -1 || c[fk + 2]?.text !== "(") continue;
    const close = c.findIndex((t, i) => i > fk + 2 && t.text === ")");
    const from = c.slice(fk + 3, close).map((t) => nameOf(t, true));
    if (!from.includes(col)) continue;
    keys.push(...referencesIn(c).filter((r) => r.parent === target));
  }
  return keys.length > 0 && keys.every((r) => r.onDelete);
}

// The column's own definition declares `PRIMARY KEY DESC`, which keeps an
// INTEGER PRIMARY KEY from being an alias of the rowid.
export function declaresPrimaryKeyDesc(
  def: TableDefinition,
  column: string,
): boolean {
  const own = def.columns.get(foldName(column)) ?? [];
  return own.some(
    (t, i) =>
      isWord(t, "PRIMARY") &&
      isWord(own[i + 1], "KEY") &&
      isWord(own[i + 2], "DESC"),
  );
}
