-- ================================================================
-- Reversal lifecycle — standard columns + backfill — 2026-04-25
--
-- Phase 1 of the ERP reversal-lifecycle work. Adds the same five
-- columns to every reversible transactional table:
--
--   is_reversed   boolean DEFAULT false  — quick predicate
--   reversed_at   timestamptz             — when (null until reversed)
--   reversed_by   uuid                    — who (FK soft-checked at app layer)
--   reversal_id   uuid                    — points forward to the row that
--                                           reversed this one
--   reverses_id   uuid                    — points back to the row that
--                                           THIS row reverses (null on
--                                           originals)
--
-- Backwards-compatible. Existing data is backfilled from the legacy
-- signals (reference_type='reversal' for fund_transactions, reason
-- string match for inventory_logs, status='reversed' for batches).
-- The old columns are not dropped — code paths that still read them
-- continue to work until everything is migrated.
--
-- Apply to both tarsyn_netaj and tarsyn_netaj_test.
-- ================================================================

-- ── fund_transactions ────────────────────────────────────────────
ALTER TABLE fund_transactions
  ADD COLUMN IF NOT EXISTS is_reversed boolean    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_id uuid;

-- Backfill: any row whose reference_type='reversal' and reference_id
-- points at another fund_transaction is itself a reversal — link both
-- sides explicitly.
UPDATE fund_transactions r
   SET reverses_id = r.reference_id
 WHERE r.reference_type = 'reversal'
   AND r.reverses_id IS NULL;

UPDATE fund_transactions o
   SET is_reversed = true,
       reversal_id = r.id,
       reversed_at = r.created_at,
       reversed_by = r.created_by
  FROM fund_transactions r
 WHERE r.reference_type = 'reversal'
   AND r.reverses_id    = o.id
   AND o.is_reversed    = false;

CREATE INDEX IF NOT EXISTS idx_fund_tx_reverses_id
  ON fund_transactions (reverses_id) WHERE reverses_id IS NOT NULL;

-- ── inventory_logs ───────────────────────────────────────────────
ALTER TABLE inventory_logs
  ADD COLUMN IF NOT EXISTS is_reversed boolean    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_id uuid;

-- Backfill: legacy reversal logs encode the original id in their
-- reason string ("Reversal of log <uuid>"). Extract the uuid and link.
UPDATE inventory_logs r
   SET reverses_id = (regexp_match(r.reason, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'))[1]::uuid
 WHERE r.reference_type = 'reversal'
   AND r.reverses_id IS NULL
   AND r.reason ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

UPDATE inventory_logs o
   SET is_reversed = true,
       reversal_id = r.id,
       reversed_at = r.created_at,
       reversed_by = r.created_by
  FROM inventory_logs r
 WHERE r.reverses_id = o.id
   AND o.is_reversed = false;

CREATE INDEX IF NOT EXISTS idx_inventory_logs_reverses_id
  ON inventory_logs (reverses_id) WHERE reverses_id IS NOT NULL;

-- ── production_batches ───────────────────────────────────────────
-- Already has status='reversed' but no FK linking the two rows.
-- Add the same standard columns here too.
ALTER TABLE production_batches
  ADD COLUMN IF NOT EXISTS is_reversed boolean    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_id uuid;

-- Backfill: rows already marked status='reversed' are flagged. The
-- forward link (reversal_id) can't be inferred without per-row data
-- so we leave it null on legacy rows.
UPDATE production_batches
   SET is_reversed = true,
       reversed_at = COALESCE(reversed_at, created_at)
 WHERE status = 'reversed'
   AND is_reversed = false;

CREATE INDEX IF NOT EXISTS idx_prod_batches_reverses_id
  ON production_batches (reverses_id) WHERE reverses_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON fund_transactions   TO tarsyn_admin;
GRANT SELECT, INSERT, UPDATE ON inventory_logs      TO tarsyn_admin;
GRANT SELECT, INSERT, UPDATE ON production_batches  TO tarsyn_admin;
