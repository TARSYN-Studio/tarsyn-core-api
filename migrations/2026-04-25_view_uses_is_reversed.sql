-- ================================================================
-- v_transaction_registry — switch to canonical is_reversed columns
-- — 2026-04-25 (follows reversal_standard_columns migration)
--
-- The previous view inferred state from reference_type / reason-string
-- matching. Now that fund_transactions and inventory_logs carry the
-- canonical (is_reversed, reverses_id) columns, the view reads them
-- directly. Cheaper (indexed) and unambiguous.
-- ================================================================

CREATE OR REPLACE VIEW v_transaction_registry AS
SELECT
  ft.id,
  ft.company_id,
  'fund'::text                          AS source_type,
  ft.transaction_type                   AS action_type,
  ft.amount,
  ft.description,
  ft.category,
  ft.transaction_number                 AS reference_number,
  false                                 AS is_deleted,
  (ft.reverses_id IS NOT NULL)          AS is_reversal,
  CASE
    WHEN ft.reverses_id IS NOT NULL THEN 'Reversal'
    WHEN ft.is_reversed             THEN 'Reversed'
    ELSE 'Active'
  END                                   AS status,
  ft.created_at,
  u.full_name                           AS created_by_name
FROM fund_transactions ft
LEFT JOIN users u ON u.id = ft.created_by

UNION ALL

SELECT
  il.id,
  il.company_id,
  'inventory'::text                     AS source_type,
  CASE
    WHEN il.change_mt > 0::numeric THEN 'inflow'::text
    ELSE 'outflow'::text
  END                                   AS action_type,
  abs(il.change_mt)                     AS amount,
  il.reason                             AS description,
  il.reference_type                     AS category,
  il.reference_type                     AS reference_number,
  false                                 AS is_deleted,
  (il.reverses_id IS NOT NULL)          AS is_reversal,
  CASE
    WHEN il.reverses_id IS NOT NULL THEN 'Reversal'
    WHEN il.is_reversed             THEN 'Reversed'
    ELSE 'Active'
  END                                   AS status,
  il.created_at,
  u.full_name                           AS created_by_name
FROM inventory_logs il
LEFT JOIN users u ON u.id = il.created_by;

GRANT SELECT ON v_transaction_registry TO tarsyn_admin;
