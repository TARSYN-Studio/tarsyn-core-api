-- ================================================================
-- Phase 2 — reversal columns + status check expansions — 2026-04-25
--
-- Extends the standard reversal lifecycle to the six top-level
-- transactional documents:
--
--   sales_orders               (customer-facing order)
--   purchase_orders            (received client PO)
--   production_orders          (factory order)
--   invoices                   (sent to customer)
--   rfqs                       (quote requests)
--   supplier_payment_ledger    (outgoing payments to suppliers)
--
-- Pattern is identical to the Phase 1 migration: add five columns,
-- expand the status CHECK constraint to allow 'reversed' / 'cancelled'
-- where missing, and create a partial index on reverses_id.
--
-- Apply to both tarsyn_netaj and tarsyn_netaj_test.
-- ================================================================

-- ── sales_orders ─────────────────────────────────────────────────
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS is_reversed boolean    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_status_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_status_check
  CHECK (status::text = ANY (ARRAY[
    'draft','confirmed','in_production','packed','booked',
    'shipped','delivered','invoiced','paid','cancelled','reversed'
  ]::text[]));

CREATE INDEX IF NOT EXISTS idx_sales_orders_reverses_id
  ON sales_orders (reverses_id) WHERE reverses_id IS NOT NULL;

-- ── purchase_orders ──────────────────────────────────────────────
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS is_reversed boolean    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status::text = ANY (ARRAY[
    'draft','received','in_production','shipped',
    'invoiced','paid','cancelled','reversed'
  ]::text[]));

CREATE INDEX IF NOT EXISTS idx_purchase_orders_reverses_id
  ON purchase_orders (reverses_id) WHERE reverses_id IS NOT NULL;

-- ── production_orders ────────────────────────────────────────────
-- No status CHECK constraint to update — only add columns.
ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS is_reversed boolean    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

CREATE INDEX IF NOT EXISTS idx_production_orders_reverses_id
  ON production_orders (reverses_id) WHERE reverses_id IS NOT NULL;

-- ── invoices ─────────────────────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS is_reversed boolean    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status::text = ANY (ARRAY[
    'draft','sent','paid','cancelled','reversed'
  ]::text[]));

CREATE INDEX IF NOT EXISTS idx_invoices_reverses_id
  ON invoices (reverses_id) WHERE reverses_id IS NOT NULL;

-- ── rfqs ─────────────────────────────────────────────────────────
ALTER TABLE rfqs
  ADD COLUMN IF NOT EXISTS is_reversed boolean    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE rfqs DROP CONSTRAINT IF EXISTS rfqs_status_check;
ALTER TABLE rfqs ADD CONSTRAINT rfqs_status_check
  CHECK (status::text = ANY (ARRAY[
    'draft','pending_factory','pending_logistics','pending_ceo',
    'approved','quotation_sent','pending_confirmation','confirmed',
    'completed','rejected','expired','sent','accepted',
    'cancelled','reversed'
  ]::text[]));

-- ── supplier_payment_ledger ──────────────────────────────────────
ALTER TABLE supplier_payment_ledger
  ADD COLUMN IF NOT EXISTS is_reversed boolean    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE supplier_payment_ledger DROP CONSTRAINT IF EXISTS supplier_payment_ledger_status_check;
ALTER TABLE supplier_payment_ledger ADD CONSTRAINT supplier_payment_ledger_status_check
  CHECK (status = ANY (ARRAY[
    'pending','approved','rejected','paid','cancelled','reversed'
  ]::text[]));

CREATE INDEX IF NOT EXISTS idx_supplier_payments_reverses_id
  ON supplier_payment_ledger (reverses_id) WHERE reverses_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON sales_orders             TO tarsyn_admin;
GRANT SELECT, INSERT, UPDATE ON purchase_orders          TO tarsyn_admin;
GRANT SELECT, INSERT, UPDATE ON production_orders        TO tarsyn_admin;
GRANT SELECT, INSERT, UPDATE ON invoices                 TO tarsyn_admin;
GRANT SELECT, INSERT, UPDATE ON rfqs                     TO tarsyn_admin;
GRANT SELECT, INSERT, UPDATE ON supplier_payment_ledger  TO tarsyn_admin;
