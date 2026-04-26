// ============================================================
//  Reversal lifecycle helper — Phase 1 of ERP correction work.
//
//  Every reversible transactional document goes through one
//  function: reverseDocument(...). It enforces:
//
//    1. The original row is locked FOR UPDATE inside a single
//       transaction — no race window between "check not reversed"
//       and "stamp as reversed".
//    2. Idempotency:
//       - 409 if is_reversed=true (already reversed)
//       - 409 if reverses_id IS NOT NULL (target is itself a
//         reversal entry — can't reverse a reversal)
//       - 404 if not found
//    3. The reversal entry is inserted by the caller (table-
//       specific shape) — caller returns { id, ...row }.
//    4. Side effects (balance / stock adjustments) run inside
//       the same transaction, after the reversal row exists,
//       so a side-effect failure rolls back the reversal too.
//    5. The original is stamped:
//         is_reversed = true
//         reversed_at = now()
//         reversed_by = userId
//         reversal_id = <reversal.id>
//    6. An audit_logs row is written with action='reverse'.
//
//  Errors thrown carry .statusCode so the route's error handler
//  can surface them as proper HTTP responses.
// ============================================================

import { withTransaction, logAudit } from '../db.js';

export class ReversalError extends Error {
  constructor(statusCode, message, payload = null) {
    super(message);
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

// Tables this helper is allowed to reverse. Each value lists the
// columns added by the 2026-04-25 reversal-columns migration so
// stamping is uniform.
const REVERSIBLE_TABLES = new Set([
  // Phase 1 — line-level transactional entries
  'fund_transactions',
  'inventory_logs',
  'production_batches',
  // Phase 2 — top-level documents
  'sales_orders',
  'purchase_orders',
  'production_orders',
  'invoices',
  'rfqs',
  'supplier_payment_ledger',
]);

/**
 * Reverse a posted document.
 *
 * @param {object}   opts
 * @param {string}   opts.table          — table name (whitelisted)
 * @param {string}   opts.id             — uuid of the row being reversed
 * @param {string}   opts.companyId      — request.user.company_id
 * @param {string}   opts.userId         — request.user.sub
 * @param {string}   [opts.reason]       — free-text reason (audit + entry desc)
 * @param {function} opts.insertReversal — async (client, orig) => { id, ... }
 *                                         Caller composes the opposing INSERT
 *                                         and returns the new row.
 * @param {function} [opts.applySideEffect] — async (client, orig, reversal) => void
 *                                         Caller adjusts balances / stock.
 * @param {object}   [opts.extraStatus]  — extra columns to set on original
 *                                         alongside the standard reversed_*
 *                                         (e.g. { status: 'reversed' } for
 *                                         tables that also keep a status
 *                                         column).
 * @returns {object} the reversal row
 */
export async function reverseDocument({
  table,
  id,
  companyId,
  userId,
  reason = 'Reversed',
  insertReversal,
  applySideEffect,
  extraStatus = null,
}) {
  if (!REVERSIBLE_TABLES.has(table)) {
    throw new ReversalError(500, `reverseDocument: '${table}' is not whitelisted`);
  }
  if (!id || !companyId) {
    throw new ReversalError(400, 'reverseDocument: id and companyId are required');
  }
  // insertReversal is optional. Line-level transactional tables (e.g.
  // fund_transactions, inventory_logs) need a counter-entry row;
  // top-level documents (sales_orders, invoices, ...) do not.

  return await withTransaction(async (client) => {
    // 1. Lock + load the original. FOR UPDATE prevents a concurrent
    //    request from stamping it between our SELECT and our UPDATE.
    const { rows: origRows } = await client.query(
      `SELECT * FROM ${table}
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [id, companyId]
    );
    if (origRows.length === 0) {
      throw new ReversalError(404, `${table.replace(/_/g, ' ')} not found`);
    }
    const orig = origRows[0];

    // 2. Idempotency / state guards.
    if (orig.reverses_id) {
      throw new ReversalError(409, 'Cannot reverse a reversal entry');
    }
    if (orig.is_reversed) {
      throw new ReversalError(
        409,
        'This document has already been reversed',
        { reversal_id: orig.reversal_id }
      );
    }

    // 3. Caller inserts the opposing entry (if any). For
    //    line-level transactional tables (fund_transactions,
    //    inventory_logs, production_batches) the caller writes a
    //    counter-entry row and returns it. For top-level documents
    //    (sales_orders, invoices, production_orders, ...) reversing
    //    means stamping the existing row terminal — there is no
    //    counter-entry. In that case the caller returns null/undefined
    //    and the helper skips reversal_id stamping.
    let reversal = null;
    if (typeof insertReversal === 'function') {
      reversal = await insertReversal(client, orig, { reason });
    }
    const hasCounterEntry = reversal && reversal.id && reversal.id !== orig.id;

    // 4. Patch reverses_id on the counter-entry if the caller forgot.
    if (hasCounterEntry && !reversal.reverses_id) {
      await client.query(
        `UPDATE ${table} SET reverses_id = $1 WHERE id = $2`,
        [orig.id, reversal.id]
      );
      reversal.reverses_id = orig.id;
    }

    // 5. Apply the side effect (balance / stock adjust). Done after
    //    the reversal row exists so the audit trail is consistent
    //    if something explodes.
    if (typeof applySideEffect === 'function') {
      await applySideEffect(client, orig, reversal);
    }

    // 6. Stamp the original row terminal. reversal_id is only set
    //    when there's a real counter-entry; otherwise the document
    //    simply transitions to is_reversed=true.
    const extraSets = [];
    const extraVals = [];
    if (extraStatus && typeof extraStatus === 'object') {
      let p = hasCounterEntry ? 5 : 4;
      for (const [col, val] of Object.entries(extraStatus)) {
        extraSets.push(`${col} = $${p++}`);
        extraVals.push(val);
      }
    }
    if (hasCounterEntry) {
      await client.query(
        `UPDATE ${table}
            SET is_reversed = true,
                reversed_at = now(),
                reversed_by = $1,
                reversal_id = $2
                ${extraSets.length ? ', ' + extraSets.join(', ') : ''}
          WHERE id = $3 AND company_id = $4`,
        [userId ?? null, reversal.id, id, companyId, ...extraVals]
      );
    } else {
      await client.query(
        `UPDATE ${table}
            SET is_reversed = true,
                reversed_at = now(),
                reversed_by = $1
                ${extraSets.length ? ', ' + extraSets.join(', ') : ''}
          WHERE id = $2 AND company_id = $3`,
        [userId ?? null, id, companyId, ...extraVals]
      );
    }

    // 7. Audit log — fire-and-forget at the helper layer.
    await logAudit({
      companyId,
      userId,
      action: 'reverse',
      entityType: table,
      entityId: id,
      reason,
      newValues: hasCounterEntry
        ? { reversal_id: reversal.id }
        : { is_reversed: true },
    });

    if (hasCounterEntry) return reversal;

    // No counter-entry: return the freshly-stamped original.
    const { rows: stamped } = await client.query(
      `SELECT * FROM ${table} WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );
    return stamped[0];
  });
}

/**
 * Cancel a document that hasn't been posted yet. No counter-entry is
 * inserted because no impact existed. The row is stamped terminal:
 *   status              = 'cancelled'
 *   cancelled_at        = now()
 *   cancelled_by        = userId
 *   cancellation_reason = reason
 *
 * Refuses 409 if:
 *   - status is already terminal (cancelled / reversed / rejected /
 *     paid / completed / shipped / delivered / invoiced / sent /
 *     funds_issued — anything that has financial or stock impact)
 *
 * @param {object}   opts
 * @param {string}   opts.table         — table name (whitelisted)
 * @param {string}   opts.id
 * @param {string}   opts.companyId
 * @param {string}   opts.userId
 * @param {string}   [opts.reason]
 * @param {string[]} [opts.cancellableStatuses] — explicit allow-list of
 *                       current statuses that may be cancelled. If omitted,
 *                       defaults to {'draft','submitted','pending'} which
 *                       covers the vast majority of unposted docs.
 * @returns the row after the cancel.
 */
export async function cancelDocument({
  table,
  id,
  companyId,
  userId,
  reason = 'Cancelled by user',
  cancellableStatuses = ['draft', 'submitted', 'pending'],
}) {
  if (!REVERSIBLE_TABLES.has(table)) {
    throw new ReversalError(500, `cancelDocument: '${table}' is not whitelisted`);
  }

  return await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status FROM ${table}
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [id, companyId]
    );
    if (rows.length === 0) {
      throw new ReversalError(404, `${table.replace(/_/g, ' ')} not found`);
    }
    const orig = rows[0];

    if (orig.status === 'cancelled') {
      throw new ReversalError(409, 'Already cancelled');
    }
    if (!cancellableStatuses.includes(orig.status)) {
      throw new ReversalError(
        409,
        `Cannot cancel — document is '${orig.status}'. Posted documents must be reversed instead.`,
        { current_status: orig.status, allowed_for_cancel: cancellableStatuses }
      );
    }

    const { rows: updated } = await client.query(
      `UPDATE ${table}
          SET status              = 'cancelled',
              cancelled_at        = now(),
              cancelled_by        = $1,
              cancellation_reason = $2
        WHERE id = $3 AND company_id = $4
        RETURNING *`,
      [userId ?? null, reason, id, companyId]
    );

    await logAudit({
      companyId,
      userId,
      action: 'cancel',
      entityType: table,
      entityId: id,
      reason,
      oldValues: { status: orig.status },
      newValues: { status: 'cancelled' },
    });

    return updated[0];
  });
}

/**
 * Tiny convenience for routes — converts a thrown ReversalError into
 * a Fastify reply at the boundary so individual route handlers stay
 * tidy.
 *
 * Usage:
 *   try {
 *     const r = await reverseDocument({...});
 *     return reply.status(201).send(r);
 *   } catch (e) {
 *     return sendReversalError(reply, e);
 *   }
 */
export function sendReversalError(reply, err) {
  if (err instanceof ReversalError) {
    const body = { error: err.message };
    if (err.payload) Object.assign(body, err.payload);
    return reply.status(err.statusCode).send(body);
  }
  // Unknown error — let Fastify default handler take it.
  throw err;
}
