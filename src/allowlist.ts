// Audited exceptions to lint findings: which findings an allowlist suppresses,
// and which of its entries suppress nothing any longer.
//
// The finding shape is the one d1-query-plan-gate's plan lint reports (rule,
// table, index, q), plus `column`, so one allowlist can hold the exceptions
// for this package's layout rules, that package's plan rules, and rules a
// caller writes over the same snapshot.

export interface Finding<Rule extends string = string> {
  rule: Rule;
  table: string;
  column?: string;
  index?: string;
  // The name of the statement a query-level finding is about.
  q?: string;
  detail: string;
}

// `rule` and `table` must equal the finding's. Each of `column`, `index` and
// `q` must equal the finding's when the entry sets it, and matches any value
// when the entry leaves it out. `reason` is what makes the entry an audited
// exception rather than a silenced one, so it is required and must say
// something.
export interface AllowlistEntry<Rule extends string = string> {
  rule: Rule;
  table: string;
  column?: string;
  index?: string;
  q?: string;
  reason: string;
}

export interface AllowlistResult<Rule extends string = string> {
  // The findings no entry suppresses: the ones a suite fails on.
  remaining: Finding<Rule>[];
  // The entries that suppress none of the findings given: dead weight that
  // looks like an audited exception and would silently absorb whatever later
  // matches it.
  unused: AllowlistEntry<Rule>[];
}

function matches(entry: AllowlistEntry, finding: Finding): boolean {
  return (
    entry.rule === finding.rule &&
    entry.table === finding.table &&
    (entry.column === undefined || entry.column === finding.column) &&
    (entry.index === undefined || entry.index === finding.index) &&
    (entry.q === undefined || entry.q === finding.q)
  );
}

function describeTarget(item: {
  table: string;
  column?: string;
  index?: string;
  q?: string;
}): string {
  if (item.q !== undefined) return `${item.q} on ${item.table}`;
  if (item.column !== undefined) return `${item.table}.${item.column}`;
  if (item.index !== undefined) return `index ${item.index} on ${item.table}`;
  return item.table;
}

// `unused` is only as complete as `findings`: an entry for a rule whose
// findings were not passed in is reported unused. Pass every finding the
// allowlist covers in one call to read `unused`; a call per rule is fine for
// `remaining`.
export function applyAllowlist<Rule extends string>(
  findings: readonly Finding<Rule>[],
  entries: readonly AllowlistEntry<Rule>[],
): AllowlistResult<Rule> {
  const blank = entries.filter((entry) => entry.reason.trim() === "");
  if (blank.length > 0) {
    throw new Error(
      "sqlite-schema-gate: every allowlist entry needs a reason; blank for:\n" +
        blank.map((e) => `  - [${e.rule}] ${describeTarget(e)}`).join("\n"),
    );
  }
  return {
    remaining: findings.filter(
      (finding) => !entries.some((entry) => matches(entry, finding)),
    ),
    unused: entries.filter(
      (entry) => !findings.some((finding) => matches(entry, finding)),
    ),
  };
}

// One line per finding, for an assertion message.
export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((f) => `  - [${f.rule}] ${describeTarget(f)}: ${f.detail}`)
    .join("\n");
}

// One line per entry, for the message of an `unused` assertion.
export function formatEntries(entries: readonly AllowlistEntry[]): string {
  return entries.map((e) => `  - [${e.rule}] ${describeTarget(e)}`).join("\n");
}
