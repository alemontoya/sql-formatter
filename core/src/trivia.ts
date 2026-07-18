import type { Token } from "./types.js";

export interface Leaf {
  token: Token;
  leadingComments: Token[];
  trailingComment: Token | null;
}

export interface TriviaResult {
  leaves: Leaf[];
  trailingDangling: Token[];
}

/**
 * Splits the raw token stream into real tokens ("leaves") with comments
 * attached to whichever leaf they belong next to. A comment on its own
 * source line is "leading" for the next leaf; a comment sharing a line
 * with the previous leaf is "trailing" for that leaf. This is what lets
 * the printer reposition comments during reflow without ever losing one.
 */
export function attachTrivia(tokens: Token[]): TriviaResult {
  const leaves: Leaf[] = [];
  let pendingLeading: Token[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "eof" || t.type === "whitespace") continue;

    if (t.type === "lineComment" || t.type === "blockComment") {
      const prev = tokens[i - 1];
      const sameLineAsPrevLeaf =
        leaves.length > 0 &&
        pendingLeading.length === 0 &&
        !(prev && prev.type === "whitespace" && prev.value.includes("\n"));
      if (sameLineAsPrevLeaf) {
        leaves[leaves.length - 1].trailingComment = t;
      } else {
        pendingLeading.push(t);
      }
      continue;
    }

    leaves.push({ token: t, leadingComments: pendingLeading, trailingComment: null });
    pendingLeading = [];
  }

  return { leaves, trailingDangling: pendingLeading };
}
