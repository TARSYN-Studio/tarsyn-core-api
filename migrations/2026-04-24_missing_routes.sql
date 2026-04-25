-- ================================================================
-- Missing-routes rescue migration — 2026-04-24
-- Adds the two tables the frontend expected but the API never had.
-- Apply to both tarsyn_netaj and tarsyn_netaj_test.
-- ================================================================

-- ── Packaging purchase requests ────────────────────────────────
CREATE TABLE IF NOT EXISTS packaging_purchase_requests (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_number        text        NOT NULL,
  item_id               uuid        REFERENCES packaging_items(id) ON DELETE SET NULL,
  item_name             text        NOT NULL,
  category              text,
  qty_requested         numeric(15,4) NOT NULL,
  unit_of_measure       text,
  needed_by_date        date,
  reason_for_request    text,
  status                text        NOT NULL DEFAULT 'submitted'
                         CHECK (status IN ('draft','submitted','manager_approved','approved','rejected','purchased')),
  requester_id          uuid,
  manager_approved_by   uuid,
  manager_approved_at   timestamptz,
  finance_approved_by   uuid,
  finance_approved_at   timestamptz,
  rejected_by           uuid,
  rejected_at           timestamptz,
  rejection_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, request_number)
);
CREATE INDEX IF NOT EXISTS idx_pkg_pr_company_status
  ON packaging_purchase_requests (company_id, status);
GRANT ALL ON packaging_purchase_requests TO tarsyn_admin;

-- ── Supplier price-change requests ─────────────────────────────
CREATE TABLE IF NOT EXISTS price_change_requests (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id           uuid        NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  current_price         numeric(15,4),
  requested_price       numeric(15,4) NOT NULL,
  currency              text        NOT NULL DEFAULT 'SAR',
  justification         text,
  status                text        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected')),
  requested_by          uuid,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  rejection_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pcr_company_status
  ON price_change_requests (company_id, status);
GRANT ALL ON price_change_requests TO tarsyn_admin;
