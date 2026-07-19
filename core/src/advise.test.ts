import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advise, type TableStats } from "./advise.js";
import { format } from "./format.js";
import type { StyleTemplate } from "./style-template.js";

const defaultTemplate = JSON.parse(
  readFileSync(new URL("../../templates/default.json", import.meta.url), "utf8"),
) as StyleTemplate;

function stats(tables: TableStats["tables"]): TableStats {
  return { id: "test", dialect: "generic", collectedAt: "2026-01-01T00:00:00Z", tables };
}

describe("advise — duplicate-subquery-cte", () => {
  it("suggests a CTE for two identical FROM/JOIN derived tables, with a working preview", () => {
    const sql = `
      SELECT a.id, b.total
      FROM (SELECT customer_id, COUNT(*) AS n FROM orders WHERE status = 'paid' GROUP BY customer_id) a
      JOIN (SELECT customer_id, COUNT(*) AS n FROM orders WHERE status = 'paid' GROUP BY customer_id) b
        ON a.customer_id = b.customer_id;
    `;
    const result = advise(sql, null, defaultTemplate);
    const suggestion = result.suggestions.find((s) => s.kind === "duplicate-subquery-cte");
    expect(suggestion).toBeDefined();
    expect(suggestion!.message).toMatch(/appears 2 times/);
    expect(suggestion!.preview).toBeDefined();
    expect(suggestion!.preview).toContain("WITH");
    // The preview must itself be valid, idempotent-formattable SQL.
    expect(() => format(suggestion!.preview!, defaultTemplate)).not.toThrow();
    expect(format(suggestion!.preview!, defaultTemplate)).toBe(suggestion!.preview);
    // Both derived-table aliases now reference the single extracted CTE.
    expect(suggestion!.preview).toMatch(/FROM \w+ a\s*\n\s*JOIN \w+ b/);
  });

  it("reuses the shared alias as the CTE name when both occurrences agree", () => {
    const sql = `
      SELECT x.n, y.n
      FROM (SELECT id, COUNT(*) AS n FROM t GROUP BY id) recent
      JOIN (SELECT id, COUNT(*) AS n FROM t GROUP BY id) recent
        ON x.id = y.id;
    `;
    // (intentionally reused alias text "recent" on both sides to exercise the naming path)
    const result = advise(sql, null, defaultTemplate);
    const suggestion = result.suggestions.find((s) => s.kind === "duplicate-subquery-cte");
    expect(suggestion!.preview).toContain("WITH\n  recent AS");
  });

  it("does not suggest anything for a single (non-duplicated) subquery", () => {
    const sql = `SELECT * FROM (SELECT id FROM orders) a JOIN customers c ON a.id = c.id;`;
    const result = advise(sql, null, defaultTemplate);
    expect(result.suggestions.filter((s) => s.kind === "duplicate-subquery-cte")).toHaveLength(0);
  });

  it("skips trivially short duplicate subqueries", () => {
    const sql = `SELECT * FROM (SELECT 1) a JOIN (SELECT 1) b ON a.x = b.x;`;
    const result = advise(sql, null, defaultTemplate);
    expect(result.suggestions.filter((s) => s.kind === "duplicate-subquery-cte")).toHaveLength(0);
  });

  it("suggests without a preview when the statement already has a WITH clause", () => {
    const sql = `
      WITH base AS (SELECT 1)
      SELECT a.n, b.n
      FROM (SELECT customer_id, COUNT(*) AS n FROM orders WHERE status = 'paid' GROUP BY customer_id) a
      JOIN (SELECT customer_id, COUNT(*) AS n FROM orders WHERE status = 'paid' GROUP BY customer_id) b
        ON a.customer_id = b.customer_id;
    `;
    const result = advise(sql, null, defaultTemplate);
    const suggestion = result.suggestions.find((s) => s.kind === "duplicate-subquery-cte");
    expect(suggestion).toBeDefined();
    expect(suggestion!.preview).toBeUndefined();
    expect(suggestion!.message).toMatch(/already has a WITH clause/);
  });
});

describe("advise — join-order", () => {
  const threeTableStats = stats({
    orders: { rowCount: 4_000_000 },
    customers: { rowCount: 500 },
    order_items: { rowCount: 10_000_000 },
  });

  it("suggests reordering when a smaller table is joined after a larger one", () => {
    const sql = `
      SELECT o.id, oi.sku, c.name
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      JOIN customers c ON o.customer_id = c.id;
    `;
    const result = advise(sql, threeTableStats, defaultTemplate);
    const suggestion = result.suggestions.find((s) => s.kind === "join-order");
    expect(suggestion).toBeDefined();
    expect(suggestion!.message).toContain("orders -> customers -> order_items");
    expect(suggestion!.preview).toBeDefined();
    expect(format(suggestion!.preview!, defaultTemplate)).toBe(suggestion!.preview);
    // The base table must never move — only the join sequence changes.
    expect(suggestion!.preview).toMatch(/^SELECT[\s\S]*FROM orders o\n/);
  });

  it("says nothing when the join order already matches the size heuristic", () => {
    const sql = `
      SELECT o.id, c.name, oi.sku
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN order_items oi ON o.id = oi.order_id;
    `;
    const result = advise(sql, threeTableStats, defaultTemplate);
    expect(result.suggestions.filter((s) => s.kind === "join-order")).toHaveLength(0);
  });

  it("does not touch a chain containing a non-INNER join", () => {
    const sql = `
      SELECT o.id, oi.sku, c.name
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN customers c ON o.customer_id = c.id;
    `;
    const result = advise(sql, threeTableStats, defaultTemplate);
    expect(result.suggestions.filter((s) => s.kind === "join-order")).toHaveLength(0);
  });

  it("skips a join whose ON condition references more than one other table", () => {
    const sql = `
      SELECT o.id, oi.sku, c.name
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      JOIN customers c ON o.customer_id = c.id AND oi.customer_id = c.id;
    `;
    const result = advise(sql, threeTableStats, defaultTemplate);
    expect(result.suggestions.filter((s) => s.kind === "join-order")).toHaveLength(0);
  });

  it("skips the whole chain when a table isn't present in stats", () => {
    const sql = `
      SELECT o.id, x.thing
      FROM orders o
      JOIN unknown_table x ON o.id = x.order_id
      JOIN customers c ON o.customer_id = c.id;
    `;
    const result = advise(sql, threeTableStats, defaultTemplate);
    expect(result.suggestions.filter((s) => s.kind === "join-order")).toHaveLength(0);
  });

  it("does nothing when stats aren't supplied at all", () => {
    const sql = `
      SELECT o.id, oi.sku, c.name
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      JOIN customers c ON o.customer_id = c.id;
    `;
    const result = advise(sql, null, defaultTemplate);
    expect(result.suggestions).toHaveLength(0);
  });
});

describe("advise — unindexed-column", () => {
  it("flags a column explicitly marked as not indexed in a WHERE condition", () => {
    const sql = `SELECT * FROM customers c WHERE c.email = 'x@example.com';`;
    const s = stats({ customers: { rowCount: 100, columns: { email: { indexed: false } } } });
    const result = advise(sql, s, defaultTemplate);
    expect(result.suggestions).toContainEqual(
      expect.objectContaining({ kind: "unindexed-column", message: expect.stringContaining("customers.email") }),
    );
  });

  it("flags a column used in a JOIN ON condition", () => {
    const sql = `SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id WHERE c.email = 'x';`;
    const s = stats({
      orders: { rowCount: 10, columns: { customer_id: { indexed: false } } },
      customers: { rowCount: 10, columns: { id: { indexed: true }, email: { indexed: true } } },
    });
    const result = advise(sql, s, defaultTemplate);
    expect(result.suggestions).toContainEqual(
      expect.objectContaining({ kind: "unindexed-column", message: expect.stringContaining("orders.customer_id") }),
    );
  });

  it("does not flag a column with no stats entry (absence isn't evidence)", () => {
    const sql = `SELECT * FROM customers c WHERE c.email = 'x@example.com';`;
    const s = stats({ customers: { rowCount: 100 } }); // no columns key at all
    const result = advise(sql, s, defaultTemplate);
    expect(result.suggestions.filter((r) => r.kind === "unindexed-column")).toHaveLength(0);
  });

  it("does not flag a column explicitly marked indexed", () => {
    const sql = `SELECT * FROM customers c WHERE c.email = 'x@example.com';`;
    const s = stats({ customers: { rowCount: 100, columns: { email: { indexed: true } } } });
    const result = advise(sql, s, defaultTemplate);
    expect(result.suggestions.filter((r) => r.kind === "unindexed-column")).toHaveLength(0);
  });

  it("only reports each unindexed column once even if referenced multiple times", () => {
    const sql = `SELECT * FROM customers c WHERE c.email = 'x' OR c.email = 'y';`;
    const s = stats({ customers: { rowCount: 100, columns: { email: { indexed: false } } } });
    const result = advise(sql, s, defaultTemplate);
    expect(result.suggestions.filter((r) => r.kind === "unindexed-column")).toHaveLength(1);
  });
});

describe("advise — multi-statement input", () => {
  it("tags each suggestion with the right statementIndex", () => {
    const sql = `
      SELECT * FROM customers c WHERE c.email = 'x';
      SELECT * FROM orders o WHERE o.status = 'paid';
    `;
    const s = stats({
      customers: { rowCount: 10, columns: { email: { indexed: false } } },
      orders: { rowCount: 10, columns: { status: { indexed: false } } },
    });
    const result = advise(sql, s, defaultTemplate);
    expect(result.suggestions.find((r) => r.message.includes("customers.email"))?.statementIndex).toBe(0);
    expect(result.suggestions.find((r) => r.message.includes("orders.status"))?.statementIndex).toBe(1);
  });
});
