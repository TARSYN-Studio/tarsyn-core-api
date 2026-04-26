-- ================================================================
-- Fix v_transaction_registry — 2026-04-25
--
-- Bug: the view hardcoded `is_reversal=false` and `status='Active'` for
--      every row. Reversal entries showed as Active. Original transactions
--      showed as Active forever, even after being reversed. The frontend
--      "Reverse" button only hides when status != 'Active', so users were
--      able to press Reverse on the same original transaction repeatedly,
--      creating one extra credit entry per click and inflating the wallet.
--
-- Fix:  - is_reversal now reflects whether the row itself is a reversal
--         (reference_type = 'reversal').
--       - status is computed:
--           Reversal     — this row is itself a reversal entry
--           Reversed     — this row has a reversal entry pointing at it
--           Active       — neither (still standing)
--       Both fund_transactions and inventory_logs branches updated.
--
-- Apply to both tarsyn_netaj and tarsyn_netaj_test.
-- ================================================================

CREATE OR REPLACE VIEW v_transaction_registry AS
SELECT
  ft.id,
  ft.company_id,
  'fund'::text                                 AS source_type,
  ft.transaction_type                          AS action_type,
  ft.amount,
  ft.description,
  ft.category,
  ft.transaction_number                        AS reference_number,
  false                                        AS is_deleted,
  (ft.reference_type = 'reversal')             AS is_reversal,
  CASE
    WHEN ft.reference_type = 'reversal' THEN 'Reversal'
    WHEN EXISTS (
      SELECT 1 FROM fund_transactions r
      WHERE r.company_id      = ft.company_id
        AND r.reference_id    = ft.id
        AND r.reference_type  = 'reversal'
    ) THEN 'Reversed'
    ELSE 'Active'
  END                                          AS status,
  ft.created_at,
  u.full_name                                  AS created_by_name
FROM fund_transactions ft
LEFT JOIN users u ON u.id = ft.created_by

UNION ALL

SELECT
  il.id,
  il.company_id,
  'inventory'::text                            AS source_type,
  CASE
    WHEN il.change_mt > 0::numeric THEN 'inflow'::text
    ELSE 'outflow'::text
  END                                          AS action_type,
  abs(il.change_mt)                            AS amount,
  il.reason                                    AS description,
  il.reference_type                            AS category,
  il.reference_type                            AS reference_number,
  false                                        AS is_deleted,
  (il.reference_type = 'reversal')             AS is_reversal,
  CASE
    WHEN il.reference_type = 'reversal' THEN 'Reversal'
    -- Inventory reversal logs encode the original id in their reason
    -- string ("Reversal of log <uuid>") since the table has no FK back.
    WHEN EXISTS (
      SELECT 1 FROM inventory_logs r
      WHERE r.company_id      = il.company_id
        AND r.reference_type  = 'reversal'
        AND r.reason LIKE '%' || il.id::text || '%'
    ) THEN 'Reversed'
    ELSE 'Active'
  END                                          AS status,
  il.created_at,
  u.full_name                                  AS created_by_name
FROM inventory_logs il
LEFT JOIN users u ON u.id = il.created_by;

GRANT SELECT ON v_transaction_registry TO tarsyn_admin;
