import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkDataLoss, findCascadeParents } from "../src/index";

// The foreign key grammar as SQLite's parser (parse.y) accepts it:
//
//   column key   [CONSTRAINT name] REFERENCES parent [(column, ...)] refarg*
//                inside a column definition, among its other constraints
//                in any order: NOT NULL, PRIMARY KEY or UNIQUE, each with an
//                optional ON CONFLICT clause, CHECK (...), DEFAULT ...,
//                COLLATE name, a second REFERENCES, and the deferrable
//                clause, which SQLite reads as a constraint of its own; in
//                CREATE TABLE or ALTER TABLE ... ADD COLUMN
//   table key    [CONSTRAINT name] FOREIGN KEY (column, ...)
//                REFERENCES parent [(column, ...)] refarg* [deferrable]
//   refarg       MATCH name | ON INSERT action | ON DELETE action
//                | ON UPDATE action, in any order and number; a later
//                clause of a kind replaces an earlier one
//   action       SET NULL | SET DEFAULT | CASCADE | RESTRICT | NO ACTION
//   deferrable   [NOT] DEFERRABLE [INITIALLY DEFERRED | INITIALLY IMMEDIATE]
//   parent, name a bare name in any case, or "double", `backtick`,
//                [bracket] or 'single' quoted, with or without a space
//                after the keyword before it
//
// Comments may stand between any two tokens.
//
// Each form below is applied to D1, so SQLite itself says it is valid, and
// its own pragma_foreign_key_list says whether the key cascades on delete.
// The lint must read the same answer from the text alone, both from the
// schema before a migration and from a key the migration declares: a
// cascade it misses is a wipe it lets through.

const COLUMN_FORMS = [
  "REFERENCES p ON DELETE CASCADE",
  "REFERENCES p(id) ON DELETE CASCADE",
  "REFERENCES p (id) ON DELETE CASCADE",
  'REFERENCES "p" ON DELETE CASCADE',
  'REFERENCES"p"ON DELETE CASCADE',
  "REFERENCES `p` ON DELETE CASCADE",
  "REFERENCES [p] ON DELETE CASCADE",
  "REFERENCES[p]ON DELETE CASCADE",
  "REFERENCES 'p' ON DELETE CASCADE",
  "REFERENCES P ON DELETE CASCADE",
  "references p on delete cascade",
  "REFERENCES p /* why */ ON -- because\n DELETE CASCADE",
  "CONSTRAINT fk REFERENCES p ON DELETE CASCADE",
  "CONSTRAINT 'fk' REFERENCES p ON DELETE CASCADE",
  "REFERENCES p ON UPDATE CASCADE ON DELETE CASCADE",
  "REFERENCES p ON UPDATE SET NULL ON DELETE CASCADE",
  "REFERENCES p ON UPDATE SET DEFAULT ON DELETE CASCADE",
  "REFERENCES p ON UPDATE RESTRICT ON DELETE CASCADE",
  "REFERENCES p ON UPDATE NO ACTION ON DELETE CASCADE",
  "REFERENCES p ON DELETE CASCADE ON UPDATE RESTRICT",
  "REFERENCES p MATCH SIMPLE ON DELETE CASCADE",
  "REFERENCES p MATCH FULL ON DELETE CASCADE",
  'REFERENCES p MATCH "partial" ON DELETE CASCADE',
  "REFERENCES p ON DELETE CASCADE MATCH SIMPLE",
  "REFERENCES p ON INSERT RESTRICT ON DELETE CASCADE",
  "REFERENCES p ON INSERT SET NULL ON DELETE CASCADE",
  "REFERENCES p ON INSERT CASCADE ON DELETE CASCADE",
  "REFERENCES p ON INSERT NO ACTION ON DELETE CASCADE",
  "REFERENCES p MATCH SIMPLE ON INSERT RESTRICT ON UPDATE CASCADE ON DELETE CASCADE",
  "REFERENCES p ON DELETE SET NULL ON DELETE CASCADE",
  "REFERENCES p ON DELETE CASCADE ON DELETE SET NULL",
  "REFERENCES p ON DELETE CASCADE ON DELETE RESTRICT ON DELETE CASCADE",
  "REFERENCES p ON DELETE CASCADE DEFERRABLE",
  "REFERENCES p ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED",
  "REFERENCES p ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE",
  "REFERENCES p ON DELETE CASCADE NOT DEFERRABLE",
  "REFERENCES p ON DELETE CASCADE NOT DEFERRABLE INITIALLY DEFERRED",
  "NOT NULL ON CONFLICT ABORT REFERENCES p ON DELETE CASCADE",
  "REFERENCES p ON DELETE CASCADE NOT NULL ON CONFLICT REPLACE",
  "UNIQUE ON CONFLICT IGNORE REFERENCES p ON DELETE CASCADE",
  "REFERENCES p ON DELETE CASCADE CHECK (pid > 0) DEFAULT 1",
  "REFERENCES p ON DELETE CASCADE COLLATE NOCASE",
  "PRIMARY KEY ON CONFLICT ROLLBACK REFERENCES p ON DELETE CASCADE",
  "REFERENCES p ON DELETE CASCADE PRIMARY KEY DESC",
  "DEFERRABLE INITIALLY DEFERRED REFERENCES p ON DELETE CASCADE",
  "REFERENCES q ON DELETE SET NULL REFERENCES p ON DELETE CASCADE",
  "REFERENCES p ON DELETE CASCADE REFERENCES q ON DELETE SET NULL",
  // Not cascades, which SQLite must agree with.
  "REFERENCES p",
  "REFERENCES p ON DELETE SET NULL",
  "REFERENCES p ON DELETE SET DEFAULT",
  "REFERENCES p ON DELETE RESTRICT",
  "REFERENCES p ON DELETE NO ACTION",
  "REFERENCES p ON UPDATE CASCADE",
  "REFERENCES p ON INSERT CASCADE",
  "REFERENCES p DEFAULT 'ON DELETE CASCADE'",
  'REFERENCES p CONSTRAINT "ON DELETE CASCADE" NOT NULL',
];

const TABLE_FORMS = [
  "FOREIGN KEY (pid) REFERENCES p ON DELETE CASCADE",
  "FOREIGN KEY (pid) REFERENCES p (id) ON DELETE CASCADE",
  "FOREIGN KEY(pid)REFERENCES p(id)ON DELETE CASCADE",
  'FOREIGN KEY ("pid") REFERENCES "p" ("id") ON DELETE CASCADE',
  "CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p ON DELETE CASCADE",
  "FOREIGN KEY (pid, qid) REFERENCES p (id, k) ON DELETE CASCADE",
  "FOREIGN KEY (pid) REFERENCES p MATCH SIMPLE ON INSERT RESTRICT ON DELETE CASCADE",
  "FOREIGN KEY (pid) REFERENCES p ON UPDATE NO ACTION ON DELETE CASCADE",
  "FOREIGN KEY (pid) REFERENCES p ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED",
  "FOREIGN KEY (pid) REFERENCES p ON DELETE CASCADE NOT DEFERRABLE",
  "FOREIGN KEY (pid) REFERENCES p ON DELETE SET NULL ON DELETE CASCADE",
  "FOREIGN KEY (pid) REFERENCES p ON DELETE CASCADE ON DELETE NO ACTION",
  "FOREIGN KEY (pid) REFERENCES p",
  // Table constraints may follow one another with no comma.
  "FOREIGN KEY (qid) REFERENCES p ON DELETE SET NULL FOREIGN KEY (pid) REFERENCES p ON DELETE CASCADE",
  "FOREIGN KEY (pid) REFERENCES p ON DELETE CASCADE FOREIGN KEY (qid) REFERENCES p ON DELETE SET NULL",
  "FOREIGN KEY (pid) REFERENCES p ON DELETE CASCADE CONSTRAINT k FOREIGN KEY (qid) REFERENCES p",
  "FOREIGN KEY (pid) REFERENCES p ON UPDATE CASCADE",
];

const PARENT = "CREATE TABLE p (id INTEGER PRIMARY KEY, k INTEGER)";

async function sqliteSaysCascade(...ddl: string[]): Promise<boolean> {
  await env.DB.batch([
    env.DB.prepare("DROP TABLE IF EXISTS c"),
    env.DB.prepare("DROP TABLE IF EXISTS p"),
    env.DB.prepare(PARENT),
    ...ddl.map((s) => env.DB.prepare(s)),
  ]);
  const fks = await env.DB.prepare(
    `SELECT "table" AS parent, on_delete FROM pragma_foreign_key_list('c')`,
  ).all<{ parent: string; on_delete: string }>();
  expect(fks.results.length).toBeGreaterThan(0);
  return fks.results.some(
    (f) => f.parent.toLowerCase() === "p" && f.on_delete === "CASCADE",
  );
}

// What the lint reads from `ddl`: a cascade parent in the schema before the
// migration, and one the migration itself declares before dropping `p`.
function lintSeesCascade(ddl: string): { before: boolean; within: boolean } {
  const wipe = (findings: { rule: string }[]) =>
    findings.some((f) => f.rule === "cascade-parent-wipe");
  return {
    before: wipe(checkDataLoss("DROP TABLE p;", `${PARENT}; ${ddl};`)),
    within: wipe(checkDataLoss(`${ddl}; DROP TABLE p;`, `${PARENT};`)),
  };
}

describe("foreign key grammar, against SQLite", () => {
  for (const form of COLUMN_FORMS) {
    it(`column form: ${form}`, async () => {
      const ddl = `CREATE TABLE c (pid INTEGER ${form}, qid INTEGER)`;
      const cascade = await sqliteSaysCascade(ddl);
      expect(findCascadeParents(ddl).has("p")).toBe(cascade);
      expect(lintSeesCascade(ddl)).toEqual({
        before: cascade,
        within: cascade,
      });
    });
  }
  for (const form of TABLE_FORMS) {
    it(`table form: ${form}`, async () => {
      const ddl = `CREATE TABLE c (pid INTEGER, qid INTEGER, ${form})`;
      const cascade = await sqliteSaysCascade(ddl);
      expect(findCascadeParents(ddl).has("p")).toBe(cascade);
      expect(lintSeesCascade(ddl)).toEqual({
        before: cascade,
        within: cascade,
      });
    });
  }
  // ALTER TABLE ... ADD COLUMN takes the column form, less the constraints
  // SQLite refuses on an added column.
  for (const form of COLUMN_FORMS.filter(
    (f) => !/NOT NULL|UNIQUE|PRIMARY KEY/.test(f),
  )) {
    it(`added column form: ${form}`, async () => {
      const create = "CREATE TABLE c (qid INTEGER)";
      const alter = `ALTER TABLE c ADD COLUMN pid INTEGER ${form}`;
      const cascade = await sqliteSaysCascade(create, alter);
      expect(lintSeesCascade(`${create}; ${alter}`)).toEqual({
        before: cascade,
        within: cascade,
      });
    });
  }
});
