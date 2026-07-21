import { tokenize } from "./tokenizer.js";
import { attachTrivia, type Leaf } from "./trivia.js";
import { splitStatements } from "./tree.js";
import { computeLines, lineIndexAt } from "./lines.js";

/**
 * Dialects this linter knows constructs for. Deliberately its own type, not
 * `StyleTemplate`'s `Dialect` — that union is locked to the three dialects
 * the *formatter* targets, a separate decision (see HANDOFF.md). Redshift
 * has no formatting support (no style-template dialect of its own) but is a
 * real portability target/source here, same precedent as `TableStats.dialect`
 * being decoupled from `Dialect` for the query advisor.
 */
export type PortabilityDialect = "postgres" | "snowflake" | "sqlite" | "redshift";

export const PORTABILITY_DIALECTS: PortabilityDialect[] = ["postgres", "snowflake", "sqlite", "redshift"];

export interface PortabilityFinding {
  /** Stable id of the rule that matched, e.g. "snowflake-qualify". */
  id: string;
  statementIndex: number;
  /** 1-based source line the construct starts on. */
  line: number;
  /** The exact matched source text. */
  snippet: string;
  message: string;
}

export interface PortabilityLintResult {
  findings: PortabilityFinding[];
}

interface PortabilityRule {
  id: string;
  /** Dialect(s) this construct is native to — the rule only runs when the
   * declared source dialect is one of these, so a target-only construct
   * that happens to appear in unrelated source SQL isn't flagged. */
  nativeTo: PortabilityDialect[];
  /** Dialects with no clean equivalent for this construct. */
  unsupportedIn: PortabilityDialect[];
  summary: string;
  reason: string;
  /** Tries to match starting at `leaves[i]`. Returns the number of leaves
   * consumed on a match, or null. Operates on a flat leaf stream (not the
   * paren-nesting tree) deliberately — every construct below is identifiable
   * from a short run of adjacent tokens alone, so there's no need for tree
   * structure, and scanning flat also reaches inside subqueries/CASE bodies
   * for free. */
  match: (leaves: Leaf[], i: number) => number | null;
}

function isKeyword(leaf: Leaf, word: string): boolean {
  return leaf.token.type === "keyword" && leaf.token.value.toUpperCase() === word;
}

function isIdentifier(leaf: Leaf, word: string): boolean {
  return leaf.token.type === "identifier" && leaf.token.value.toUpperCase() === word;
}

function isIdentifierPrefixed(leaf: Leaf, prefix: string): boolean {
  return leaf.token.type === "identifier" && leaf.token.value.toUpperCase().startsWith(prefix);
}

function isPunct(leaf: Leaf, value: string): boolean {
  return leaf.token.type === "punctuation" && leaf.token.value === value;
}

function isOperator(leaf: Leaf, value: string): boolean {
  return leaf.token.type === "operator" && leaf.token.value === value;
}

/** identifier immediately followed by "(" — the function-call shape. */
function functionCall(name: string) {
  return (leaves: Leaf[], i: number): number | null => {
    const l = leaves[i];
    return l && isIdentifier(l, name) && leaves[i + 1] && isPunct(leaves[i + 1]!, "(") ? 2 : null;
  };
}

function functionCallPrefixed(prefix: string) {
  return (leaves: Leaf[], i: number): number | null => {
    const l = leaves[i];
    return l && isIdentifierPrefixed(l, prefix) && leaves[i + 1] && isPunct(leaves[i + 1]!, "(") ? 2 : null;
  };
}

function bareKeyword(word: string) {
  return (leaves: Leaf[], i: number): number | null => (leaves[i] && isKeyword(leaves[i]!, word) ? 1 : null);
}

function bareIdentifier(word: string) {
  return (leaves: Leaf[], i: number): number | null => (leaves[i] && isIdentifier(leaves[i]!, word) ? 1 : null);
}

const PORTABILITY_RULES: PortabilityRule[] = [
  // --- Snowflake-native --------------------------------------------------
  {
    id: "snowflake-qualify",
    nativeTo: ["snowflake"],
    unsupportedIn: ["postgres", "redshift", "sqlite"],
    summary: "QUALIFY filters rows on a window function's result directly in a clause.",
    reason: "This target has no QUALIFY clause — rewrite as a subquery/CTE with the window function computed first and a WHERE filter applied outside it.",
    match: bareKeyword("QUALIFY"),
  },
  {
    id: "snowflake-flatten",
    nativeTo: ["snowflake"],
    unsupportedIn: ["postgres", "redshift", "sqlite"],
    summary: "FLATTEN(...) unnests a semi-structured VARIANT array/object into rows.",
    reason: "This target has no FLATTEN table function — postgres has jsonb_array_elements() (different signature/semantics), redshift and sqlite have no direct equivalent.",
    match: functionCall("FLATTEN"),
  },
  {
    id: "snowflake-try-cast",
    nativeTo: ["snowflake"],
    unsupportedIn: ["postgres", "redshift", "sqlite"],
    summary: "TRY_CAST(...) casts and returns NULL instead of erroring on failure.",
    reason: "This target has no TRY_CAST/TRY_TO_* family of safe casts — emulate with a CASE expression guarding the cast, or a regex check before casting.",
    match: (leaves, i) => functionCall("TRY_CAST")(leaves, i) ?? functionCallPrefixed("TRY_TO_")(leaves, i),
  },
  {
    id: "snowflake-semistructured-cast",
    nativeTo: ["snowflake"],
    unsupportedIn: ["postgres", "redshift", "sqlite"],
    summary: "::VARIANT / ::OBJECT / ::ARRAY casts to Snowflake's schemaless semi-structured types.",
    reason: "This target has no VARIANT/OBJECT/ARRAY type — postgres has JSONB, redshift has SUPER, each with different syntax and semantics; sqlite has no comparable type at all.",
    match: (leaves, i) => {
      const op = leaves[i];
      const next = leaves[i + 1];
      if (!op || !isOperator(op, "::") || !next) return null;
      const word = next.token.type === "identifier" ? next.token.value.toUpperCase() : "";
      return word === "VARIANT" || word === "OBJECT" || word === "ARRAY" ? 2 : null;
    },
  },

  // --- Redshift-native -----------------------------------------------------
  {
    id: "redshift-getdate",
    nativeTo: ["redshift"],
    unsupportedIn: ["postgres", "snowflake", "sqlite"],
    summary: "GETDATE() returns the current timestamp.",
    reason: "This target doesn't recognize GETDATE() — use CURRENT_TIMESTAMP (postgres, sqlite) or CURRENT_TIMESTAMP()/now() equivalents (snowflake) instead.",
    match: functionCall("GETDATE"),
  },
  {
    id: "redshift-identity",
    nativeTo: ["redshift"],
    unsupportedIn: ["postgres", "snowflake", "sqlite"],
    summary: "IDENTITY(seed, step) is Redshift's auto-increment column default.",
    reason: "This target uses a different auto-increment mechanism — GENERATED ... AS IDENTITY or SERIAL (postgres), AUTOINCREMENT (snowflake, sqlite).",
    match: functionCall("IDENTITY"),
  },
  {
    id: "redshift-distribution",
    nativeTo: ["redshift"],
    unsupportedIn: ["postgres", "snowflake", "sqlite"],
    summary: "DISTKEY/SORTKEY/DISTSTYLE declare Redshift's MPP row distribution and sort order.",
    reason: "This target has no equivalent data-distribution concept to declare — these table properties can just be dropped, not translated.",
    match: (leaves, i) => {
      const l = leaves[i];
      return l && (isIdentifier(l, "DISTKEY") || isIdentifier(l, "SORTKEY") || isIdentifier(l, "DISTSTYLE")) ? 1 : null;
    },
  },
  {
    id: "redshift-approximate-count",
    nativeTo: ["redshift"],
    unsupportedIn: ["postgres", "snowflake", "sqlite"],
    summary: "APPROXIMATE COUNT(DISTINCT ...) is Redshift's approximate-distinct-count syntax.",
    reason: "This target has no APPROXIMATE keyword — snowflake has APPROX_COUNT_DISTINCT() as a function instead; postgres/sqlite need an extension (e.g. HyperLogLog) or an exact COUNT(DISTINCT ...).",
    match: (leaves, i) => {
      const a = leaves[i];
      const b = leaves[i + 1];
      const c = leaves[i + 2];
      return a && isIdentifier(a, "APPROXIMATE") && b && isIdentifier(b, "COUNT") && c && isPunct(c, "(") ? 3 : null;
    },
  },

  // --- Postgres-native -----------------------------------------------------
  {
    id: "postgres-returning",
    nativeTo: ["postgres"],
    unsupportedIn: ["snowflake", "redshift"],
    summary: "RETURNING gets back the affected rows from an INSERT/UPDATE/DELETE.",
    reason: "This target has no RETURNING clause — run a separate SELECT to fetch the affected rows instead.",
    match: bareKeyword("RETURNING"),
  },
  {
    id: "postgres-distinct-on",
    nativeTo: ["postgres"],
    unsupportedIn: ["snowflake", "redshift", "sqlite"],
    summary: "DISTINCT ON (...) keeps the first row per distinct value of the given expression(s).",
    reason: "This target has no DISTINCT ON — rewrite with ROW_NUMBER() OVER (PARTITION BY ...) filtered to row 1 instead.",
    match: (leaves, i) => {
      const a = leaves[i];
      const b = leaves[i + 1];
      const c = leaves[i + 2];
      return a && isKeyword(a, "DISTINCT") && b && isKeyword(b, "ON") && c && isPunct(c, "(") ? 3 : null;
    },
  },
  {
    id: "postgres-generate-series",
    nativeTo: ["postgres"],
    unsupportedIn: ["snowflake", "redshift", "sqlite"],
    summary: "generate_series(...) produces a set of rows from a numeric/date range.",
    reason: "This target has no generate_series() — snowflake needs GENERATOR()+seq4()/row_number(), redshift/sqlite need a recursive CTE counting up to the desired range instead.",
    match: functionCall("GENERATE_SERIES"),
  },
  {
    id: "postgres-serial-type",
    nativeTo: ["postgres"],
    unsupportedIn: ["snowflake", "redshift", "sqlite"],
    summary: "SERIAL/BIGSERIAL/SMALLSERIAL is postgres's auto-increment pseudo-type.",
    reason: "This target has no SERIAL type — use AUTOINCREMENT (snowflake, sqlite) or an IDENTITY(seed, step) column default (redshift) instead.",
    match: (leaves, i) => {
      const l = leaves[i];
      return l && (isIdentifier(l, "SERIAL") || isIdentifier(l, "BIGSERIAL") || isIdentifier(l, "SMALLSERIAL")) ? 1 : null;
    },
  },

  // --- SQLite-native -------------------------------------------------------
  {
    id: "sqlite-autoincrement",
    nativeTo: ["sqlite"],
    unsupportedIn: ["postgres", "redshift"],
    summary: "AUTOINCREMENT (after INTEGER PRIMARY KEY) guarantees monotonically increasing rowids.",
    reason: "This target doesn't recognize AUTOINCREMENT as column syntax — use SERIAL/GENERATED ... AS IDENTITY (postgres) or IDENTITY(seed, step) (redshift) instead. (Snowflake also supports AUTOINCREMENT natively, so it's not flagged as a target here.)",
    match: bareIdentifier("AUTOINCREMENT"),
  },
  {
    id: "sqlite-without-rowid",
    nativeTo: ["sqlite"],
    unsupportedIn: ["postgres", "snowflake", "redshift"],
    summary: "WITHOUT ROWID opts a table out of sqlite's implicit rowid storage.",
    reason: "This target has no rowid concept to opt out of — drop this table option entirely when porting.",
    match: (leaves, i) => {
      const a = leaves[i];
      const b = leaves[i + 1];
      return a && isIdentifier(a, "WITHOUT") && b && isIdentifier(b, "ROWID") ? 2 : null;
    },
  },
  {
    id: "sqlite-pragma",
    nativeTo: ["sqlite"],
    unsupportedIn: ["postgres", "snowflake", "redshift"],
    summary: "PRAGMA reads/writes sqlite-specific connection or database settings.",
    reason: "This target has no PRAGMA statement — the equivalent setting, if any, is configured differently per-target (session parameters, config files, or isn't applicable at all).",
    match: (leaves, i) => (i === 0 && leaves[i] && isIdentifier(leaves[i]!, "PRAGMA") ? 1 : null),
  },
];

/**
 * Flags constructs in `sql` (written for `source`) that have no clean
 * equivalent in `target`. Purely a heuristic pattern-matcher over the token
 * stream — NOT a verified compatibility matrix or a rewriter. It never
 * changes the query; every finding is a text-only heads-up naming the
 * construct and why it doesn't carry over, for you to address by hand.
 * Dialect support evolves, so treat findings as a starting point to verify
 * against your target's current docs, not a final answer.
 */
export function lintPortability(sql: string, source: PortabilityDialect, target: PortabilityDialect): PortabilityLintResult {
  const tokens = tokenize(sql);
  const { leaves } = attachTrivia(tokens);
  const statements = splitStatements(leaves);
  const lines = computeLines(sql);
  const findings: PortabilityFinding[] = [];

  if (source === target) return { findings };

  const rules = PORTABILITY_RULES.filter((r) => r.nativeTo.includes(source) && r.unsupportedIn.includes(target));
  if (rules.length === 0) return { findings };

  statements.forEach((stmt, statementIndex) => {
    const stmtLeaves = stmt.leaves;
    for (let i = 0; i < stmtLeaves.length; i++) {
      for (const rule of rules) {
        const len = rule.match(stmtLeaves, i);
        if (len === null) continue;
        const startTok = stmtLeaves[i]!.token;
        const endTok = stmtLeaves[i + len - 1]!.token;
        findings.push({
          id: rule.id,
          statementIndex,
          line: lineIndexAt(lines, startTok.start) + 1,
          snippet: sql.slice(startTok.start, endTok.end),
          message: `${rule.summary} ${rule.reason}`,
        });
      }
    }
  });

  return { findings };
}
