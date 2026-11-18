import { describe, expect, it } from "vitest";
import {
  applyAllowlist,
  formatEntries,
  formatFindings,
  type AllowlistEntry,
  type Finding,
} from "../src/index";

const FINDINGS: Finding[] = [
  {
    rule: "fk-needs-lead-index",
    table: "books",
    column: "author_id",
    detail: "d1",
  },
  {
    rule: "fk-needs-lead-index",
    table: "books",
    column: "shelf_id",
    detail: "d2",
  },
  { rule: "strict-required", table: "legacy_tags", detail: "d3" },
  {
    rule: "no-scan-on-user-tables",
    table: "books",
    index: "idx_books_title",
    q: "BOOKS_BY_TITLE",
    detail: "d4",
  },
];

describe("applyAllowlist", () => {
  it("subtracts the findings an entry matches and keeps the rest", () => {
    const entries: AllowlistEntry[] = [
      {
        rule: "fk-needs-lead-index",
        table: "books",
        column: "author_id",
        reason: "books are only ever deleted with their author, in bulk",
      },
    ];
    const { remaining, unused } = applyAllowlist(FINDINGS, entries);
    expect(remaining.map((f) => f.detail)).toEqual(["d2", "d3", "d4"]);
    expect(unused).toEqual([]);
  });

  // A field the entry leaves out matches any value, which is what makes a
  // table-level entry cover every column; the precision is the entry's choice.
  it("treats an omitted column, index or q as matching any value", () => {
    const { remaining } = applyAllowlist(FINDINGS, [
      { rule: "fk-needs-lead-index", table: "books", reason: "r" },
    ]);
    expect(remaining.map((f) => f.detail)).toEqual(["d3", "d4"]);
  });

  // The finding shape d1-query-plan-gate's plan lint reports, keyed by `q`
  // and `index`, goes through the same allowlist.
  it("matches a query-level finding on index and q", () => {
    const { remaining } = applyAllowlist(FINDINGS, [
      {
        rule: "no-scan-on-user-tables",
        table: "books",
        index: "idx_books_title",
        q: "BOOKS_BY_TITLE",
        reason: "r",
      },
    ]);
    expect(remaining.map((f) => f.detail)).toEqual(["d1", "d2", "d3"]);
  });

  // An entry that suppresses nothing looks like an audited exception and would
  // absorb whatever later matches it, so it is reported, not ignored. An entry
  // that names the right table but a different column is the realistic case:
  // the column was renamed and the entry was not.
  it("reports entries that suppress nothing", () => {
    const stale: AllowlistEntry = {
      rule: "fk-needs-lead-index",
      table: "books",
      column: "writer_id",
      reason: "r",
    };
    const wrongRule: AllowlistEntry = {
      rule: "strict-required",
      table: "books",
      reason: "r",
    };
    const { unused } = applyAllowlist(FINDINGS, [stale, wrongRule]);
    expect(unused).toEqual([stale, wrongRule]);
  });

  // The reason is what separates an audited exception from a silenced one.
  it("refuses an entry with a blank reason", () => {
    expect(() =>
      applyAllowlist(FINDINGS, [
        { rule: "strict-required", table: "legacy_tags", reason: "  " },
      ]),
    ).toThrow(/needs a reason[\s\S]*\[strict-required\] legacy_tags/);
  });
});

describe("formatting", () => {
  it("names each finding's target the way its fields allow", () => {
    expect(formatFindings(FINDINGS)).toBe(
      [
        "  - [fk-needs-lead-index] books.author_id: d1",
        "  - [fk-needs-lead-index] books.shelf_id: d2",
        "  - [strict-required] legacy_tags: d3",
        "  - [no-scan-on-user-tables] BOOKS_BY_TITLE on books: d4",
      ].join("\n"),
    );
    expect(
      formatEntries([{ rule: "r", table: "t", index: "idx_t", reason: "x" }]),
    ).toBe("  - [r] index idx_t on t");
  });
});
