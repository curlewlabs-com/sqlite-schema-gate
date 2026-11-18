// Splitting SQL text into statements, and the keyword view the text lints
// match against. Both lints read SQL through these, so there is one tokenizer
// to get right.

// Split SQL into statements, dropping comments and respecting every quoting
// form SQLite accepts, so a keyword inside a comment or a string literal is
// never read as an operation. Migration files discuss DROP TABLE in prose all
// the time; a naive split would fire on the prose and make the lint noise.
export function tokenizeStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  // The close character of the quote we are inside, or "" when unquoted.
  let quoteClose = "";
  const OPEN: Record<string, string> = {
    "'": "'",
    '"': '"',
    "`": "`",
    "[": "]",
  };
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (quoteClose) {
      buf += ch;
      if (ch === quoteClose) {
        // Doubling escapes the quote for ' " ` - a doubled close stays inside.
        if (quoteClose !== "]" && sql[i + 1] === quoteClose) {
          buf += sql[i + 1];
          i += 2;
          continue;
        }
        quoteClose = "";
      }
      i++;
      continue;
    }
    const openClose = ch === undefined ? undefined : OPEN[ch];
    if (openClose) {
      quoteClose = openClose;
      buf += ch;
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      // A token boundary where the comment was.
      buf += " ";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      buf += " ";
      continue;
    }
    if (ch === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// A statement as the keyword tests see it: single-quoted literals blanked and
// whitespace collapsed, so `DEFAULT 'DROP TABLE x'` cannot read as a drop.
// Identifiers are always extracted from the raw text, which keeps them; this
// view is for deciding what kind of statement it is.
export function keywordView(raw: string): string {
  return raw
    .replace(/'[^']*'/g, "''")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// A one-line, bounded excerpt of a statement for a finding's message.
export function excerpt(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > 80 ? `${flat.slice(0, 80)}...` : flat);
}
