import { tokenize } from "./tokenizer.js";
import { attachTrivia } from "./trivia.js";
import { splitStatements, buildTree } from "./tree.js";
import { printStatement } from "./printer.js";
import type { StyleTemplate } from "./style-template.js";

export function format(sql: string, template: StyleTemplate): string {
  const tokens = tokenize(sql);
  const { leaves, trailingDangling } = attachTrivia(tokens);
  const statements = splitStatements(leaves);

  const printed = statements.map(({ leaves: stmtLeaves }) => {
    const tree = buildTree(stmtLeaves);
    let text = printStatement(tree, template.style);
    if (template.style.statementTerminator.alwaysAppendSemicolon) text += ";";
    return text;
  });

  const separator =
    template.style.blankLines.betweenStatements === "none"
      ? "\n"
      : "\n\n"; // "preserve" not yet supported: falls back to collapse-to-one

  let out = printed.join(separator);

  if (trailingDangling.length > 0) {
    out += "\n" + trailingDangling.map((c) => c.value).join("\n");
  }

  return out + "\n";
}
