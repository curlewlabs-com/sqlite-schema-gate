// Reading SQL text: splitting it into statements, cutting a statement into
// tokens, and the keyword view the seed fence matches against. Both text
// lints read SQL through these, so there is one tokenizer to get right.

// One token of SQL text, as SQLite's own tokenizer (tokenize.c) cuts it.
//
//   word    a bare identifier or keyword; SQLite reads `$` and any non-ASCII
//           character as part of one, so `p$archive` is one word
//   name    a quoted identifier, "double", `backtick` or [bracket]; `value`
//           is the name with its quoting removed and a doubled quote undone
//   string  a single-quoted literal; `value` is its content
//   number  a numeric literal
//   other   a blob literal, a parameter, or punctuation, one character at a
//           time except for those
//
// A quote with no closing quote is an `other` token of its own and the text
// after it is read on as if unquoted. SQLite reads the rest of the input as
// one illegal token and runs nothing from there on, so reading on can only
// add findings: a malformed statement still shows its keywords, and a later
// `;` still ends it.
export interface Token {
  kind: "word" | "name" | "string" | "number" | "other";
  text: string;
  value: string;
}

// A token, or a comment, with its place in the text it was cut from.
interface Lexeme {
  token: Token | null;
  start: number;
  end: number;
}

const CLOSE_QUOTE: Readonly<Record<string, string>> = {
  "'": "'",
  '"': '"',
  "`": "`",
  "[": "]",
};

// SQLite's whitespace is ASCII only; JavaScript's \s would also take the
// non-ASCII spaces SQLite reads as part of a name.
function isSpace(ch: string): boolean {
  return /[ \t\n\v\f\r]/.test(ch);
}

// SQLite's identifier characters: ASCII letters, digits, `_` and `$`, and
// every non-ASCII character, a non-breaking space or a byte order mark
// inside a name included.
function isIdChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 0x7f;
}

// The length of the parameter at `sql[i]`, cut as SQLite cuts it: `?` and
// its digits, or `$`, `@`, `:` or `#` and a name, where the name may carry
// `::` parts and end in a `(...)` suffix that runs to the first `)` or space,
// whatever it holds. Zero when SQLite would read no parameter there. Cut
// shorter, its tail would read as a keyword (`#WHERE`), a parenthesis or a
// statement's end (`$v(;)`).
function parameterLength(sql: string, i: number): number {
  let j = i + 1;
  if (sql[i] === "?") {
    while (/[0-9]/.test(sql[j] ?? "")) j++;
    return j - i;
  }
  let n = 0;
  while (j < sql.length) {
    const c = sql[j] as string;
    if (isIdChar(c)) {
      n++;
      j++;
    } else if (c === "(" && n > 0) {
      j++;
      while (j < sql.length && !isSpace(sql[j] as string) && sql[j] !== ")") {
        j++;
      }
      if (sql[j] === ")") j++;
      break;
    } else if (c === ":" && sql[j + 1] === ":") {
      j += 2;
    } else {
      break;
    }
  }
  return n === 0 ? 0 : j - i;
}

const NUMBER_RE =
  /^(?:0[xX][0-9A-Fa-f_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/;

// Every token and comment in `sql`, in order. Statement splitting and the
// token view both come from this one walk, so a `;` or a quote inside a
// string, a name or a parameter means the same thing to both.
function lex(sql: string): Lexeme[] {
  const out: Lexeme[] = [];
  const n = sql.length;
  let i = 0;
  const push = (token: Token | null, end: number) => {
    out.push({ token, start: i, end });
    i = end;
  };
  while (i < n) {
    const ch = sql[i] as string;
    // A byte order mark where a token could start is whitespace to SQLite;
    // inside a name or a parameter it is part of it.
    if (isSpace(ch) || ch === "\uFEFF") {
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      push(null, nl === -1 ? n : nl);
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      push(null, close === -1 ? n : close + 2);
      continue;
    }
    const close = CLOSE_QUOTE[ch];
    if (close) {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < n) {
        const c = sql[j] as string;
        if (c === close) {
          // Doubling escapes the quote for ' " ` - a doubled close stays inside.
          if (close !== "]" && sql[j + 1] === close) {
            value += close;
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        value += c;
        j++;
      }
      if (!closed) {
        push({ kind: "other", text: ch, value: ch }, i + 1);
        continue;
      }
      // x'...' is a blob literal, not the word x followed by a string.
      const prev = out[out.length - 1];
      if (
        ch === "'" &&
        prev?.token?.kind === "word" &&
        /^[xX]$/.test(prev.token.text) &&
        prev.end === i
      ) {
        out.pop();
        i = prev.start;
        push({ kind: "other", text: sql.slice(i, j), value }, j);
        continue;
      }
      const kind = ch === "'" ? "string" : "name";
      push({ kind, text: sql.slice(i, j), value }, j);
      continue;
    }
    const number = /[0-9.]/.test(ch) ? NUMBER_RE.exec(sql.slice(i)) : null;
    if (number) {
      push(
        { kind: "number", text: number[0], value: number[0] },
        i + number[0].length,
      );
      continue;
    }
    if (isIdChar(ch) && ch !== "$") {
      let j = i + 1;
      while (j < n && isIdChar(sql[j] as string)) j++;
      const text = sql.slice(i, j);
      push({ kind: "word", text, value: text }, j);
      continue;
    }
    // A parameter is one token, so its name is never read as a word.
    const parameter = /[?:@$#]/.test(ch) ? parameterLength(sql, i) : 0;
    if (parameter > 0) {
      push(
        { kind: "other", text: sql.slice(i, i + parameter), value: "" },
        i + parameter,
      );
      continue;
    }
    push({ kind: "other", text: ch, value: ch }, i + 1);
  }
  return out;
}

// Split SQL into statements at each `;` token, with every comment replaced
// by a space, so a keyword inside a comment, a string literal, a quoted name
// or a parameter is never read as an operation. Migration files discuss DROP
// TABLE in prose all the time; a naive split would fire on the prose and make
// the lint noise. A statement keeps the rest of its text as written, so its
// tokens are the same when it is cut again.
export function tokenizeStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let hasToken = false;
  let firstToken = 0;
  let lastTokenEnd = 0;
  let at = 0;
  const flush = () => {
    if (hasToken) out.push(buf.slice(firstToken, lastTokenEnd));
    buf = "";
    hasToken = false;
  };
  for (const { token, start, end } of lex(sql)) {
    buf += sql.slice(at, start);
    at = end;
    if (token === null) {
      buf += " ";
      continue;
    }
    if (token.kind === "other" && token.text === ";") {
      flush();
      continue;
    }
    if (!hasToken) firstToken = buf.length;
    buf += token.text;
    lastTokenEnd = buf.length;
    hasToken = true;
  }
  flush();
  return out;
}

// The tokens of one statement, comments left out.
export function sqlTokens(statement: string): Token[] {
  return lex(statement).flatMap((l) => (l.token ? [l.token] : []));
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

// True when `token` is the bare keyword `word` (given in upper case).
export function isWord(token: Token | undefined, word: string): boolean {
  return token?.kind === "word" && token.text.toUpperCase() === word;
}

// SQLite folds only ASCII letters when it compares identifiers.
export function foldName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// A one-line, bounded excerpt of a statement for a finding's message.
export function excerpt(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > 80 ? `${flat.slice(0, 80)}...` : flat);
}
