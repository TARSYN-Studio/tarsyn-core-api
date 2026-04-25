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
  'fund_transactions',
  'inventory_logs',
  'production_batches',
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
  if (typeof insertReversal !== 'function') {
    throw new ReversalError(500, 'reverseDocument: insertReversal callback required');
  }

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

    // 3. Caller inserts the opposing entry. We pass the canonical
    //    reverses_id back-pointer so it lands on the new row no matter
    //    what shape the caller's INSERT is.
    const reversal = await insertReversal(client, orig, { reason });
    if (!reversal || !reversal.id) {
      throw new ReversalError(500, 'insertReversal must return a row with an id');
    }

    // 4. Make sure the reversal row has reverses_id set. Belt-and-
    //    braces — the caller is supposed to set it, but if they
    //    didn't, we patch it here so the linkage is intact.
    if (!reversal.reverses_id) {
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

    // 6. Stamp the original row. Using a single UPDATE so the row
    //    transitions atomically from {is_reversed:false} to
    //    {is_reversed:true, reversal_id, reversed_*}.
    const extraSets = [];
    const extraVals = [];
    if (extraStatus && typeof extraStatus === 'object') {
      let p = 5;
      for (const [col, val] of Object.entries(extraStatus)) {
        extraSets.push(`${col} = $${p++}`);
        extraVals.push(val);
      }
    }
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

    // 7. Audit log — fire-and-forget at the helper layer.
    await logAudit({
      companyId,
      userId,
      action: 'reverse',
      entityType: table,
      entityId: id,
      reason,
      newValues: { reversal_id: reversal.id },
    });

    return reversal;
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
