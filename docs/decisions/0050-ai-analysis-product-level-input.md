---
status: proposed
date: 2026-11-18
---

# ADR-050 — Product-level input for the on-demand AI analysis

Numbering continues the global sequence (`ADR-001`…`ADR-049`). Plan: `docs/PLAN.md` M5-S3. Amends `ADR-046` §3 (snapshot contents) and `ADR-049`; provider, authorization, output contract and persistence are unchanged.

## Context and Problem Statement

`ADR-046` limited the snapshot to sales and category-level data, so the analysis had to say that product-level detail was unavailable. Owners asked for answers that name real products: what sells best and worst, what does not sell at all, and what is about to run out.

## Decision Outcome

1. **New deterministic inputs** in the snapshot under `products`, computed in SQL/TypeScript from the same authorized analytics context (organization or one branch, source cutoff, completed days) as the sales metrics:
   - top five and slowest five products by **net quantity** and by **net sales** (sales minus refunds in the period; slowest are chosen among products that sold and exclude those already in the matching top list; ties break by name);
   - `noSales`: active products that have an inventory balance in the scope but no net sales in the period (count and up to ten names);
   - `outOfStock`: active stocked products with on-hand ≤ 0 (count, up to ten, most-demanded first);
   - `lowStock`: active stocked products with on-hand > 0 whose on-hand covers at most **7 days** at the period's own average daily net quantity (`on-hand × days ≤ 7 × net quantity`, one exact division for `daysOfCover`, two decimals); up to ten, least cover first.
   All money and quantity arithmetic uses exact decimals. On-hand is the sum over the scope's branches.
2. **Not ADR-030.** `lowStock` here is an input rule for the analysis text, based on the selected period's pace; it is not the ADR-030 `LOW_STOCK` classification (28-day velocity, per Branch/Product) shown in Inventory Analytics. The prompt describes it as "covers at most N days at the period's pace".
3. **Prompt.** The Products, Notes & risks and Recommended actions sections must use these facts and name real products from the data; empty lists are stated as "none apply". Forecast, reorder quantities, suppliers and purchasing facts remain out of scope.
4. **Data minimization.** Only product names and aggregates are sent; no product ids, SKUs, barcodes, customer, user or credential data, and no cost/COGS per product. The numeric validator of `ADR-046` still requires every number in the output to appear in the snapshot (digits inside product names are part of the snapshot).
5. **Safety bound.** The product query returns at most 5,000 products; a larger catalog makes the snapshot unavailable rather than ranking a partial list.
6. **Empty period.** A period with zero sales returns `422 INSUFFICIENT_DATA` with a clear message, calls no provider, stores nothing and does not spend the per-user allowance.

## Consequences

- One additional read query per analysis; no schema change or migration.
- Product names come from the catalog and reach the prompt as JSON data; the output contract and validator remain the guard against instruction-like names.
- The seven-day rule is a fixed default; making it configurable is future work.
