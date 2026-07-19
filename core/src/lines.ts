/** Source-position helpers. Tokens keep `start`/`end` as offsets into the
 * original source string, so line/column info is recoverable directly from
 * `sql` without any extra parsing infrastructure. Shared by `infer.ts`
 * (style inference reads line positions to guess formatting conventions) and
 * `format.ts` (preserving the original blank-line count between statements). */

export interface SourceLines {
  raw: string;
  starts: number[]; // offset each line begins at, sorted
  text: string[]; // each line's text (no trailing \n)
}

export function computeLines(sql: string): SourceLines {
  const text = sql.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const line of text) {
    starts.push(pos);
    pos += line.length + 1;
  }
  return { raw: sql, starts, text };
}

export function lineIndexAt(lines: SourceLines, offset: number): number {
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
