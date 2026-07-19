import { tokenize } from "./tokenizer.js";
import { attachTrivia, type Leaf } from "./trivia.js";
import { splitStatements, buildTree } from "./tree.js";
import { printStatement } from "./printer.js";
import { computeLines, lineIndexAt, type SourceLines } from "./lines.js";
import type { StyleTemplate } from "./style-template.js";

/** Blank lines actually separating two statements in the original source —
 * counted between the end of the previous statement's last real token and
 * the start of the next statement's first token (the `;` in between, if
 * any, isn't a leaf `splitStatements` keeps around, but it sits on the
 * previous statement's last line in practice, so this still measures the
 * right gap). */
function originalBlankLines(prevLeaves: Leaf[], curLeaves: Leaf[], lines: SourceLines): number {
  const prevLast = prevLeaves[prevLeaves.length - 1];
  const curFirst = curLeaves[0];
  if (!prevLast || !curFirst) return 0;
  const prevLine = lineIndexAt(lines, prevLast.token.end);
  const curLine = lineIndexAt(lines, curFirst.token.start);
  return Math.max(0, curLine - prevLine - 1);
}

export function format(sql: string, template: StyleTemplate): string {
  const tokens = tokenize(sql);
  const { leaves, trailingDangling } = attachTrivia(tokens);
  const statements = splitStatements(leaves);
  const lines = computeLines(sql);

  const printed = statements.map(({ leaves: stmtLeaves }) => {
    const tree = buildTree(stmtLeaves);
    let text = printStatement(tree, template.style);
    if (template.style.statementTerminator.alwaysAppendSemicolon) text += ";";
    return text;
  });

  const mode = template.style.blankLines.betweenStatements;
  let out = printed[0] ?? "";
  for (let i = 1; i < printed.length; i++) {
    const blanks =
      mode === "none" ? 0 : mode === "collapseToOne" ? 1 : originalBlankLines(statements[i - 1].leaves, statements[i].leaves, lines);
    out += "\n".repeat(blanks + 1) + printed[i];
  }

  if (trailingDangling.length > 0) {
    out += "\n" + trailingDangling.map((c) => c.value).join("\n");
  }

  return out + "\n";
}
