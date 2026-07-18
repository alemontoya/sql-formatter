import { tokenize } from "./tokenizer.js";
import { attachTrivia, type Leaf } from "./trivia.js";
import { splitStatements, buildTree, type Node } from "./tree.js";
import { splitClauses, type Clause } from "./clauses.js";
import { classifyLeaf, splitTopLevelCommas, canonicalFamilyWord } from "./printer.js";
import { isKeyword } from "./keywords.js";
import type { StyleTemplate, CasingRule } from "./style-template.js";
import type { Token, Dialect } from "./types.js";

export interface InferOptions {
  id: string;
  name: string;
  dialect: Dialect;
  description?: string;
  /** Fallback values for any field this pass finds no signal for. */
  baseTemplate: StyleTemplate;
}

export interface InferResult {
  template: StyleTemplate;
  warnings: string[];
}

// Mirrors the private sets in printer.ts — not exported from there since
// they're printer-internal wiring, but inference needs the same grouping to
// read the example the same way the printer would write it.
const LIST_CLAUSES = new Set(["SELECT", "FROM", "GROUP BY", "ORDER BY", "RETURNING", "VALUES", "SET"]);
const CONDITION_CLAUSES = new Set(["WHERE", "HAVING"]);

/** A field observation reduced to a chosen value + confidence, keyed later
 * into `source.confidence` by dotted path. */
interface Choice<T> {
  value: T;
  confidence: number;
}

/** Picks the majority value from a tally, discounting confidence when there
 * are few observations (a single data point shouldn't read as certainty) and
 * when observations disagree. */
function chooseByVote<T>(counts: Map<T, number>, fallback: T): Choice<T> {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { value: fallback, confidence: 0 };
  const [value, best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const agreement = best / total;
  const sampleFactor = Math.min(1, total / 3);
  return { value, confidence: Math.round(agreement * sampleFactor * 100) / 100 };
}

function tally<T>(values: T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

// ---------------------------------------------------------------------------
// Source-position helpers. The tokenizer keeps `start`/`end` as offsets into
// the original source string, so line/column info is recoverable directly
// from `sql` without any extra parsing infrastructure.

interface SourceLines {
  raw: string;
  starts: number[]; // offset each line begins at, sorted
  text: string[]; // each line's text (no trailing \n)
}

function computeLines(sql: string): SourceLines {
  const text = sql.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const line of text) {
    starts.push(pos);
    pos += line.length + 1;
  }
  return { raw: sql, starts, text };
}

function lineIndexAt(lines: SourceLines, offset: number): number {
  let lo = 0;
  let hi = lines.starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines.starts[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function columnAt(lines: SourceLines, offset: number): number {
  return offset - lines.starts[lineIndexAt(lines, offset)];
}

/** True if only whitespace precedes `offset` on its own source line. */
function isAtLineStart(lines: SourceLines, offset: number): boolean {
  const idx = lineIndexAt(lines, offset);
  return lines.text[idx].slice(0, offset - lines.starts[idx]).trim() === "";
}

/** True if only whitespace follows `offset` (a token's end) on its line. */
function isAtLineEnd(lines: SourceLines, offset: number): boolean {
  const idx = lineIndexAt(lines, offset);
  return lines.text[idx].slice(offset - lines.starts[idx]).trim() === "";
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

// ---------------------------------------------------------------------------

function casingPattern(word: string): CasingRule | null {
  if (!/[A-Za-z]/.test(word)) return null;
  if (word === word.toUpperCase()) return "upper";
  if (word === word.toLowerCase()) return "lower";
  if (word[0] === word[0].toUpperCase() && word.slice(1) === word.slice(1).toLowerCase()) return "capitalize";
  return "preserve";
}

/** Recursively walks a node sequence (and every nested group's own content
 * as its own sequence — matching how `classifyLeaf`/the printer treat
 * scopes), classifying every leaf the same way the printer would when
 * deciding what casing rule to apply. */
function walkForCasing(nodes: Node[], onLeaf: (kind: "keyword" | "function" | "type" | "identifier", word: string) => void) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.kind === "leaf") {
      const kind = classifyLeaf(nodes, i);
      if (kind !== "raw") onLeaf(kind, node.leaf.token.value);
    } else {
      walkForCasing(node.content, onLeaf);
    }
  }
}

function inferCasing(statementTrees: Node[][]): Record<"keywords" | "functions" | "types" | "identifiers", Choice<CasingRule>> {
  const buckets: Record<string, CasingRule[]> = { keyword: [], function: [], type: [], identifier: [] };
  for (const tree of statementTrees) {
    walkForCasing(tree, (kind, word) => {
      const pattern = casingPattern(word);
      if (pattern) buckets[kind].push(pattern);
    });
  }
  return {
    keywords: chooseByVote(tally(buckets.keyword), "upper"),
    functions: chooseByVote(tally(buckets.function), "upper"),
    types: chooseByVote(tally(buckets.type), "upper"),
    identifiers: chooseByVote(tally(buckets.identifier), "preserve"),
  };
}

// ---------------------------------------------------------------------------

interface StatementInfo {
  leaves: Leaf[];
  hadSemicolon: boolean;
  tree: Node[];
  clauses: Clause[];
}

function isSubqueryGroup(content: Node[]): boolean {
  const first = content[0];
  return !!first && first.kind === "leaf" && first.leaf.token.type === "keyword" &&
    (first.leaf.token.value.toUpperCase() === "SELECT" || first.leaf.token.value.toUpperCase() === "WITH");
}

/** Classifies one statement's clause layout as "indent" or "keywordAlign" by
 * comparing how consistent clause keywords' *start* column is (indent mode:
 * every clause at a given level starts at the same column) versus how
 * consistent their *end* column is (align mode: every clause's reference
 * word ends at the same shared column, regardless of the clause's own
 * length) — verified this distinguishes the two cleanly on real examples,
 * without needing to reverse-engineer exact alignment arithmetic (which is
 * noisy on hand-typed SQL — see HANDOFF.md). */
function classifyStatementLayout(clauses: Clause[], lines: SourceLines): "indent" | "keywordAlign" | null {
  // The family's first member (e.g. a top-level SELECT, or WITH) is always
  // flush-left in *both* layout modes — it carries no signal, and worse,
  // including it can coincidentally tie the two variances (seen on a real
  // fixture: SELECT's flush-left column matched WHERE's, making startVar
  // and endVar equal by chance). Only non-first family members actually
  // differ in behavior between the two modes.
  const family = clauses.filter((c) => c.keyword !== "" && c.keywordLeaves.length > 0).slice(1);
  if (family.length < 2) return null;

  const starts = family.map((c) => columnAt(lines, c.keywordLeaves[0].leaf.token.start));
  const ends = family.map((c, i) => starts[i] + canonicalFamilyWord(c.keyword).length - 1);

  const variance = (arr: number[]) => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  };

  const startVar = variance(starts);
  const endVar = variance(ends);
  if (startVar === endVar) return null;
  return startVar < endVar ? "indent" : "keywordAlign";
}

function inferLayoutMode(statements: StatementInfo[], lines: SourceLines): Choice<"indent" | "keywordAlign"> {
  const votes: ("indent" | "keywordAlign")[] = [];
  const collect = (nodes: Node[]) => {
    const clauses = splitClauses(nodes);
    const v = classifyStatementLayout(clauses, lines);
    if (v) votes.push(v);
    for (const clause of clauses) {
      for (const node of clause.body) {
        if (node.kind === "group" && isSubqueryGroup(node.content)) collect(node.content);
      }
    }
  };
  for (const s of statements) collect(s.tree);
  return chooseByVote(tally(votes), "indent");
}

// ---------------------------------------------------------------------------

function leadingWidth(line: string): number {
  return line.match(/^[ \t]*/)?.[0].length ?? 0;
}

/** CASE/WHEN/END nesting always adds exactly one `indentSize` step between
 * a CASE block's WHEN/ELSE branches and its own END line, in *either*
 * layout mode — a much cleaner signal than raw line-to-line indent deltas,
 * which in keywordAlign mode are dominated by keyword-width-driven jumps
 * that aren't multiples of any fixed unit and would otherwise GCD down to
 * a meaningless 1 (verified: this happened before this function existed). */
function collectCaseIndentDeltas(nodes: Node[], lines: SourceLines, out: number[]) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.kind === "group") {
      collectCaseIndentDeltas(node.content, lines, out);
      continue;
    }
    if (node.leaf.token.type !== "keyword" || node.leaf.token.value.toUpperCase() !== "CASE") continue;

    let depth = 1;
    let j = i + 1;
    let whenLine = -1;
    while (j < nodes.length && depth > 0) {
      const n = nodes[j];
      if (n.kind === "leaf" && n.leaf.token.type === "keyword") {
        const w = n.leaf.token.value.toUpperCase();
        if (w === "CASE") depth++;
        else if (w === "END") {
          depth--;
          if (depth === 0) break;
        } else if (depth === 1 && whenLine === -1 && (w === "WHEN" || w === "ELSE")) {
          whenLine = lineIndexAt(lines, n.leaf.token.start);
        }
      }
      j++;
    }
    if (whenLine !== -1 && j < nodes.length) {
      const endLine = lineIndexAt(lines, (nodes[j] as { kind: "leaf"; leaf: Leaf }).leaf.token.start);
      const delta = Math.abs(leadingWidth(lines.text[whenLine]) - leadingWidth(lines.text[endLine]));
      if (delta > 0 && delta <= 8) out.push(delta);
    }
  }
}

function inferIndentation(
  statementTrees: Node[][],
  lines: SourceLines,
  layoutMode: "indent" | "keywordAlign"
): { char: Choice<"space" | "tab">; size: Choice<number> } {
  const chars: ("space" | "tab")[] = [];
  for (const line of lines.text) {
    if (line.trim() === "") continue;
    const leading = line.match(/^[ \t]*/)?.[0] ?? "";
    if (leading.length > 0) chars.push(leading.includes("\t") ? "tab" : "space");
  }
  const char = chooseByVote(tally(chars), "space");

  const caseDeltas: number[] = [];
  for (const tree of statementTrees) collectCaseIndentDeltas(tree, lines, caseDeltas);
  if (caseDeltas.length > 0) {
    const size = caseDeltas.reduce((a, b) => gcd(a, b));
    const confidence = Math.round(Math.min(1, caseDeltas.length / 3) * 100) / 100;
    return { char, size: { value: Math.min(8, Math.max(1, size)), confidence } };
  }

  // No CASE blocks to anchor on — fall back to raw line-to-line indent
  // deltas. In keywordAlign mode this is known-noisy (most line-start
  // columns are keyword-width-driven, not multiples of any fixed unit —
  // verified: this path alone mispredicted size on a real fixture with no
  // CASE blocks), so it's capped much lower there than in indent mode.
  const widths: number[] = [];
  let prevWidth = 0;
  for (const line of lines.text) {
    if (line.trim() === "") continue;
    const width = leadingWidth(line);
    if (width > 0) {
      const delta = width - prevWidth;
      if (delta > 0 && delta <= 8) widths.push(delta);
    }
    prevWidth = width;
  }
  if (widths.length === 0) return { char, size: { value: 2, confidence: 0 } };
  const size = widths.reduce((a, b) => gcd(a, b));
  const cap = layoutMode === "keywordAlign" ? 0.15 : 0.5;
  const sizeConfidence = Math.round(Math.min(cap, widths.length / 5) * 100) / 100;
  return { char, size: { value: Math.min(8, Math.max(1, size)), confidence: sizeConfidence } };
}

function inferLineWidth(lines: SourceLines): Choice<number> {
  const max = Math.max(0, ...lines.text.map((l) => l.length));
  if (max === 0) return { value: 100, confidence: 0 };
  const value = Math.min(200, Math.max(60, Math.ceil((max + 5) / 10) * 10));
  return { value, confidence: Math.round(Math.min(0.6, lines.text.length / 50) * 100) / 100 };
}

// ---------------------------------------------------------------------------

function inferForceNewlinePerClause(statements: StatementInfo[], lines: SourceLines): Choice<boolean> {
  const votes: boolean[] = [];
  const collect = (nodes: Node[]) => {
    const clauses = splitClauses(nodes).filter((c) => c.keyword !== "");
    if (clauses.length >= 2) {
      for (const clause of clauses.slice(1)) {
        votes.push(isAtLineStart(lines, clause.keywordLeaves[0].leaf.token.start));
      }
    }
    for (const clause of splitClauses(nodes)) {
      for (const node of clause.body) {
        if (node.kind === "group" && isSubqueryGroup(node.content)) collect(node.content);
      }
    }
  };
  for (const s of statements) collect(s.tree);
  return chooseByVote(tally(votes), true);
}

/** True only if a statement with 2+ clauses is directly observed sitting
 * entirely on one source line — a positive, narrow signal. Absence of such
 * a statement isn't strong evidence either way (most scripts just don't
 * happen to have a short enough one), so it defaults to false/no-confidence
 * rather than voting "false" from silence. */
function inferInlineShortStatements(statements: StatementInfo[], lines: SourceLines): Choice<boolean> {
  const multiClause = statements.filter((s) => s.clauses.filter((c) => c.keyword !== "").length >= 2);
  for (const s of multiClause) {
    const first = s.leaves[0];
    const last = s.leaves[s.leaves.length - 1];
    if (!first || !last) continue;
    if (lineIndexAt(lines, first.token.start) === lineIndexAt(lines, last.token.end)) {
      return { value: true, confidence: 0.5 };
    }
  }
  return { value: false, confidence: 0 };
}

// ---------------------------------------------------------------------------

function firstLeafOf(node: Node): Leaf {
  return node.kind === "leaf" ? node.leaf : firstLeafOf(node.content[0] ?? { kind: "leaf", leaf: node.open });
}

function inferListsOnePerLine(statements: StatementInfo[], lines: SourceLines): Choice<boolean> {
  const votes: boolean[] = [];
  const collect = (nodes: Node[]) => {
    for (const clause of splitClauses(nodes)) {
      if (LIST_CLAUSES.has(clause.keyword)) {
        const items = splitTopLevelCommas(clause.body);
        if (items.length >= 2) {
          const itemLines = items.map((item) => lineIndexAt(lines, firstLeafOf(item[0]).token.start));
          const allDistinct = new Set(itemLines).size === itemLines.length;
          votes.push(allDistinct);
        }
      }
      for (const node of clause.body) {
        if (node.kind === "group" && isSubqueryGroup(node.content)) collect(node.content);
      }
    }
  };
  for (const s of statements) collect(s.tree);
  return chooseByVote(tally(votes), true);
}

function inferCommaStyle(statements: StatementInfo[], lines: SourceLines): Choice<"leading" | "trailing"> {
  const votes: ("leading" | "trailing")[] = [];
  const collect = (nodes: Node[]) => {
    for (const clause of splitClauses(nodes)) {
      if (LIST_CLAUSES.has(clause.keyword) || clause.keyword === "WITH") {
        let scanNodes = clause.body;
        if (clause.keyword === "WITH" && scanNodes[0]?.kind === "leaf" && scanNodes[0].leaf.token.value.toUpperCase() === "RECURSIVE") {
          scanNodes = scanNodes.slice(1);
        }
        for (const node of scanNodes) {
          if (node.kind === "leaf" && node.leaf.token.type === "punctuation" && node.leaf.token.value === ",") {
            const tok = node.leaf.token;
            if (isAtLineEnd(lines, tok.end)) votes.push("trailing");
            else if (isAtLineStart(lines, tok.start)) votes.push("leading");
          }
        }
      }
      for (const node of clause.body) {
        if (node.kind === "group" && isSubqueryGroup(node.content)) collect(node.content);
      }
    }
  };
  for (const s of statements) collect(s.tree);
  return chooseByVote(tally(votes), "trailing");
}

function inferJoinOnPlacement(statements: StatementInfo[], lines: SourceLines): Choice<"sameLine" | "newLine"> {
  const votes: ("sameLine" | "newLine")[] = [];
  const collect = (nodes: Node[]) => {
    for (const clause of splitClauses(nodes)) {
      if (clause.keyword.endsWith("JOIN")) {
        const onIdx = clause.body.findIndex(
          (n) => n.kind === "leaf" && n.leaf.token.type === "keyword" && n.leaf.token.value.toUpperCase() === "ON"
        );
        if (onIdx > 0) {
          const onLeaf = (clause.body[onIdx] as { kind: "leaf"; leaf: Leaf }).leaf;
          const prevLast = clause.body[onIdx - 1];
          const prevLine = lineIndexAt(lines, lastOffsetOf(prevLast));
          const onLine = lineIndexAt(lines, onLeaf.token.start);
          votes.push(prevLine === onLine ? "sameLine" : "newLine");
        }
      }
      for (const node of clause.body) {
        if (node.kind === "group" && isSubqueryGroup(node.content)) collect(node.content);
      }
    }
  };
  for (const s of statements) collect(s.tree);
  return chooseByVote(tally(votes), "sameLine");
}

function lastOffsetOf(node: Node): number {
  if (node.kind === "leaf") return node.leaf.token.end;
  return node.close ? node.close.token.end : lastOffsetOf(node.content[node.content.length - 1]);
}

function inferBooleanOperatorStyle(statements: StatementInfo[], lines: SourceLines): Choice<"leading" | "trailing"> {
  const votes: ("leading" | "trailing")[] = [];
  const collectChain = (nodes: Node[]) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.kind !== "leaf") continue;
      const t = node.leaf.token;
      if (t.type === "keyword" && (t.value.toUpperCase() === "AND" || t.value.toUpperCase() === "OR")) {
        if (isAtLineStart(lines, t.start)) votes.push("leading");
        else if (isAtLineEnd(lines, t.end)) votes.push("trailing");
      }
    }
  };
  const collect = (nodes: Node[]) => {
    for (const clause of splitClauses(nodes)) {
      if (CONDITION_CLAUSES.has(clause.keyword)) collectChain(clause.body);
      if (clause.keyword.endsWith("JOIN")) collectChain(clause.body);
      for (const node of clause.body) {
        if (node.kind === "group" && isSubqueryGroup(node.content)) collect(node.content);
      }
    }
  };
  for (const s of statements) collect(s.tree);
  return chooseByVote(tally(votes), "leading");
}

function inferCtes(statements: StatementInfo[], lines: SourceLines): { onePerLine: Choice<boolean>; blankLineBetween: Choice<boolean> } {
  const onePerLineVotes: boolean[] = [];
  const blankVotes: boolean[] = [];
  const collect = (nodes: Node[]) => {
    for (const clause of splitClauses(nodes)) {
      if (clause.keyword === "WITH") {
        let body = clause.body;
        if (body[0]?.kind === "leaf" && body[0].leaf.token.value.toUpperCase() === "RECURSIVE") body = body.slice(1);
        const items = splitTopLevelCommas(body);
        if (items.length >= 2) {
          const itemStartLines = items.map((item) => lineIndexAt(lines, firstLeafOf(item[0]).token.start));
          onePerLineVotes.push(new Set(itemStartLines).size === itemStartLines.length);
          // blankLineBetween is about the gap between one CTE's *end* and
          // the next one's *start* — not between their start lines, which
          // would conflate "this CTE's body spans many lines" with "there's
          // a blank line here" (verified: this was a real bug, caught by a
          // false positive on a real fixture with no blank lines at all).
          for (let i = 1; i < items.length; i++) {
            const prevEndLine = lineIndexAt(lines, lastOffsetOf(items[i - 1][items[i - 1].length - 1]));
            const curStartLine = itemStartLines[i];
            blankVotes.push(curStartLine - prevEndLine >= 2);
          }
        }
        for (const item of items) {
          for (const node of item) {
            if (node.kind === "group" && isSubqueryGroup(node.content)) collect(node.content);
          }
        }
      }
      for (const node of clause.body) {
        if (node.kind === "group" && isSubqueryGroup(node.content)) collect(node.content);
      }
    }
  };
  for (const s of statements) collect(s.tree);
  return {
    onePerLine: chooseByVote(tally(onePerLineVotes), true),
    blankLineBetween: chooseByVote(tally(blankVotes), false),
  };
}

function inferSubqueryParen(statements: StatementInfo[], lines: SourceLines): Choice<boolean> {
  const votes: boolean[] = [];
  const walk = (nodes: Node[]) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.kind === "group") {
        if (isSubqueryGroup(node.content)) {
          const prev = nodes[i - 1];
          if (prev) {
            const prevLine = lineIndexAt(lines, lastOffsetOf(prev));
            const parenLine = lineIndexAt(lines, node.open.token.start);
            votes.push(prevLine === parenLine);
          }
        }
        walk(node.content);
      }
    }
  };
  for (const s of statements) walk(s.tree);
  return chooseByVote(tally(votes), true);
}

// ---------------------------------------------------------------------------

const UNQUOTED_SAFE = /^[a-z_][a-z0-9_]*$/i;

function inferQuoting(allLeaves: Leaf[]): { quoteChar: Choice<"double" | "backtick" | "bracket" | "none">; forceQuoteIdentifiers: Choice<boolean> } {
  const quoted = allLeaves.filter((l) => l.token.type === "quotedIdentifier");
  const chars: ("double" | "backtick")[] = [];
  let unnecessary = 0;
  for (const leaf of quoted) {
    const v = leaf.token.value;
    if (v.startsWith('"')) chars.push("double");
    else if (v.startsWith("`")) chars.push("backtick");
    const inner = v.slice(1, -1);
    if (UNQUOTED_SAFE.test(inner) && !isKeyword(inner)) unnecessary++;
  }
  const quoteChar =
    quoted.length === 0
      ? { value: "none" as const, confidence: allLeaves.length > 20 ? 0.3 : 0.1 }
      : chooseByVote(tally(chars), "double" as "double" | "backtick");
  const forceQuoteIdentifiers: Choice<boolean> =
    quoted.length === 0 ? { value: false, confidence: 0 } : { value: unnecessary > 0, confidence: Math.min(1, quoted.length / 3) };
  return { quoteChar, forceQuoteIdentifiers };
}

// ---------------------------------------------------------------------------

function inferBlankLinesBetweenStatements(statements: StatementInfo[], lines: SourceLines): Choice<"preserve" | "collapseToOne" | "none"> {
  const votes: ("preserve" | "collapseToOne" | "none")[] = [];
  for (let i = 1; i < statements.length; i++) {
    const prevLast = statements[i - 1].leaves[statements[i - 1].leaves.length - 1];
    const curFirst = statements[i].leaves[0];
    if (!prevLast || !curFirst) continue;
    const prevLine = lineIndexAt(lines, prevLast.token.end);
    const curLine = lineIndexAt(lines, curFirst.token.start);
    const blankLines = Math.max(0, curLine - prevLine - 1);
    votes.push(blankLines === 0 ? "none" : blankLines === 1 ? "collapseToOne" : "preserve");
  }
  return chooseByVote(tally(votes), "collapseToOne");
}

function inferBlankLinesAroundCtes(statements: StatementInfo[], lines: SourceLines): Choice<boolean> {
  const votes: boolean[] = [];
  const collect = (nodes: Node[], scopeFirstOffset: number) => {
    const clauses = splitClauses(nodes);
    for (const clause of clauses) {
      if (clause.keyword === "WITH" && clause.keywordLeaves.length > 0) {
        const withOffset = clause.keywordLeaves[0].leaf.token.start;
        const withLine = lineIndexAt(lines, withOffset);
        const beforeBlank = withLine > lineIndexAt(lines, scopeFirstOffset) && lines.text[withLine - 1]?.trim() === "";
        votes.push(beforeBlank);
      }
      for (const node of clause.body) {
        if (node.kind === "group" && isSubqueryGroup(node.content)) {
          collect(node.content, node.open.token.start);
        }
      }
    }
  };
  for (const s of statements) {
    if (s.leaves.length > 0) collect(s.tree, s.leaves[0].token.start);
  }
  return chooseByVote(tally(votes), false);
}

// ---------------------------------------------------------------------------

export function inferStyleTemplate(sql: string, options: InferOptions): InferResult {
  const tokens = tokenize(sql);
  const { leaves } = attachTrivia(tokens);
  const lines = computeLines(sql);

  const statements: StatementInfo[] = splitStatements(leaves).map(({ leaves: stmtLeaves, hadSemicolon }) => {
    const tree = buildTree(stmtLeaves);
    return { leaves: stmtLeaves, hadSemicolon, tree, clauses: splitClauses(tree) };
  });

  const statementTrees = statements.map((s) => s.tree);
  const casing = inferCasing(statementTrees);
  const layout = inferLayoutMode(statements, lines);
  const indentation = inferIndentation(statementTrees, lines, layout.value);
  const lineWidth = inferLineWidth(lines);
  const forceNewlinePerClause = inferForceNewlinePerClause(statements, lines);
  const inlineShortStatements = inferInlineShortStatements(statements, lines);
  const listsOnePerLine = inferListsOnePerLine(statements, lines);
  const commaStyle = inferCommaStyle(statements, lines);
  const joinOnPlacement = inferJoinOnPlacement(statements, lines);
  const booleanOperatorStyle = inferBooleanOperatorStyle(statements, lines);
  const ctes = inferCtes(statements, lines);
  const subqueryParen = inferSubqueryParen(statements, lines);
  const quoting = inferQuoting(leaves);
  const blankLinesBetweenStatements = inferBlankLinesBetweenStatements(statements, lines);
  const blankLinesAroundCtes = inferBlankLinesAroundCtes(statements, lines);
  const alwaysAppendSemicolon = chooseByVote(tally(statements.map((s) => s.hadSemicolon)), true);

  const base = options.baseTemplate.style;
  const style: StyleTemplate["style"] = {
    layout: { mode: layout.value },
    casing: {
      keywords: casing.keywords.value,
      functions: casing.functions.value,
      types: casing.types.value,
      identifiers: casing.identifiers.value,
    },
    indentation: { char: indentation.char.value, size: indentation.size.value },
    lineWidth: lineWidth.value,
    clauses: { forceNewlinePerClause: forceNewlinePerClause.value, inlineShortStatements: inlineShortStatements.value },
    lists: {
      onePerLine: listsOnePerLine.value,
      // wrapThresholdItems is deliberately not inferred (see field table in
      // HANDOFF.md), but blindly copying the base template's value is
      // actively wrong when onePerLine flips to false: e.g. default.json's
      // wrapThresholdItems=1 is only harmless there because onePerLine=true
      // already forces wrapping regardless — paired with an inferred
      // onePerLine=false it would force *every* list to wrap unconditionally,
      // the opposite of what "not one-per-line" is supposed to mean.
      // Falling back to "effectively never trigger by count" instead lets
      // lineWidth alone decide, which is what a false onePerLine implies.
      wrapThresholdItems: listsOnePerLine.value ? base.lists.wrapThresholdItems : 999,
    },
    commas: { style: commaStyle.value, alignAfterComma: base.commas.alignAfterComma },
    joins: { onClausePlacement: joinOnPlacement.value, multiConditionIndent: base.joins.multiConditionIndent },
    booleanOperators: { style: booleanOperatorStyle.value, indentContinuation: base.booleanOperators.indentContinuation },
    ctes: { onePerLine: ctes.onePerLine.value, blankLineBetween: ctes.blankLineBetween.value },
    parentheses: { subqueryOpenParenSameLine: subqueryParen.value },
    alignment: { aliases: base.alignment.aliases, assignments: base.alignment.assignments },
    quoting: { forceQuoteIdentifiers: quoting.forceQuoteIdentifiers.value, quoteChar: quoting.quoteChar.value },
    blankLines: { betweenStatements: blankLinesBetweenStatements.value, aroundCtes: blankLinesAroundCtes.value },
    statementTerminator: { alwaysAppendSemicolon: alwaysAppendSemicolon.value },
  };

  const confidence: Record<string, number> = {
    "layout.mode": layout.confidence,
    "casing.keywords": casing.keywords.confidence,
    "casing.functions": casing.functions.confidence,
    "casing.types": casing.types.confidence,
    "casing.identifiers": casing.identifiers.confidence,
    "indentation.char": indentation.char.confidence,
    "indentation.size": indentation.size.confidence,
    lineWidth: lineWidth.confidence,
    "clauses.forceNewlinePerClause": forceNewlinePerClause.confidence,
    "clauses.inlineShortStatements": inlineShortStatements.confidence,
    "lists.onePerLine": listsOnePerLine.confidence,
    "lists.wrapThresholdItems": 0,
    "commas.style": commaStyle.confidence,
    "commas.alignAfterComma": 0,
    "joins.onClausePlacement": joinOnPlacement.confidence,
    "joins.multiConditionIndent": 0,
    "booleanOperators.style": booleanOperatorStyle.confidence,
    "booleanOperators.indentContinuation": 0,
    "ctes.onePerLine": ctes.onePerLine.confidence,
    "ctes.blankLineBetween": ctes.blankLineBetween.confidence,
    "parentheses.subqueryOpenParenSameLine": subqueryParen.confidence,
    "alignment.aliases": 0,
    "alignment.assignments": 0,
    "quoting.forceQuoteIdentifiers": quoting.forceQuoteIdentifiers.confidence,
    "quoting.quoteChar": quoting.quoteChar.confidence,
    "blankLines.betweenStatements": blankLinesBetweenStatements.confidence,
    "blankLines.aroundCtes": blankLinesAroundCtes.confidence,
    "statementTerminator.alwaysAppendSemicolon": alwaysAppendSemicolon.confidence,
  };

  const warnings = Object.entries(confidence)
    .filter(([, c]) => c < 0.4)
    .map(([field, c]) => `${field}: low confidence (${c}), defaulted from base template`);

  const template: StyleTemplate = {
    id: options.id,
    name: options.name,
    description: options.description,
    version: "1.0.0",
    schemaVersion: options.baseTemplate.schemaVersion,
    dialect: options.dialect,
    extends: null,
    source: { type: "inferred", confidence },
    style,
  };

  return { template, warnings };
}
