import { queueEmail, emailTemplate } from '../services/email.js';
import { notifyPayrollApproved, notifyPayrollSubmitted } from '../services/teamsNotify.js';
import { query } from '../db.js';
import fs from 'fs';
import path from 'path';

const isUUID = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const safeUUID = (v) => isUUID(v) ? v : null;

const FINANCE_ROLES = ['admin', 'ceo', 'finance', 'finance_user'];

export default async function hrRoutes(app) {

  // ── GET /api/hr/employees ─────────────────────────────────────
  app.get('/employees', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { status, department } = request.query;
    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (status) { conditions.push(`status = $${p++}`); params.push(status); }
    if (department) { conditions.push(`department = $${p++}`); params.push(department); }
    const { rows } = await query(
      `SELECT * FROM employees WHERE ${conditions.join(' AND ')} ORDER BY full_name`,
      params
    );
    return { data: rows };
  });

  // ── POST /api/hr/employees ────────────────────────────────────
  app.post('/employees', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['full_name'],
        properties: {
          employee_number:    { type: 'string' },
          full_name:          { type: 'string' },
          nationality:        { type: 'string' },
          job_title:          { type: 'string' },
          department:         { type: 'string' },
          basic_salary:       { type: 'number' },
          housing_allowance:  { type: 'number' },
          transport_allowance:{ type: 'number' },
          other_allowances:   { type: 'number' },
          iqama_number:       { type: 'string' },
          iqama_expiry:       { type: 'string' },
          passport_number:    { type: 'string' },
          passport_expiry:    { type: 'string' },
          contract_start:     { type: 'string' },
          contract_end:       { type: 'string' },
          status:             { type: 'string' },
          notes:              { type: 'string' },
          bank_account:       { type: 'string' },
          bank_name:          { type: 'string' },
          iban:               { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { company_id } = request.user;
    const b = request.body;
    const { rows } = await query(
      `INSERT INTO employees
         (company_id, employee_number, full_name, nationality, job_title, department,
          basic_salary, housing_allowance, transport_allowance, other_allowances,
          iqama_number, iqama_expiry, passport_number, passport_expiry,
          contract_start, contract_end, status, notes, bank_account, bank_name, iban)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [company_id, b.employee_number||null, b.full_name, b.nationality||null,
       b.job_title||null, b.department||null, b.basic_salary||null,
       b.housing_allowance||0, b.transport_allowance||0, b.other_allowances||0,
       b.iqama_number||null, b.iqama_expiry||null, b.passport_number||null,
       b.passport_expiry||null, b.contract_start||null, b.contract_end||null,
       b.status||'active', b.notes||null, b.bank_account||null, b.bank_name||null, b.iban||null]
    );
    return reply.status(201).send(rows[0]);
  });


  // ── POST /api/hr/employees/import ─────────────────────────────
  app.post('/employees/import', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['rows'],
        properties: {
          rows: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['full_name'],
              properties: {
                full_name:           { type: 'string' },
                employee_number:     { type: 'string' },
                job_title:           { type: 'string' },
                department:          { type: 'string' },
                basic_salary:        { type: ['number', 'string'] },
                housing_allowance:   { type: ['number', 'string'] },
                transport_allowance: { type: ['number', 'string'] },
                other_allowances:    { type: ['number', 'string'] },
                nationality:         { type: 'string' },
                iqama_number:        { type: 'string' },
                iqama_expiry:        { type: 'string' },
                passport_number:     { type: 'string' },
                passport_expiry:     { type: 'string' },
                bank_name:           { type: 'string' },
                bank_account:        { type: 'string' },
                iban:                { type: 'string' },
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows: inputRows } = request.body;
    let created = 0;
    let updated = 0;
    const skipped = [];

    for (let i = 0; i < inputRows.length; i += 1) {
      const raw = inputRows[i] || {};
      const fullName = String(raw.full_name || '').trim();
      if (!fullName) {
        skipped.push({ row: i + 1, reason: 'Missing full_name' });
        continue;
      }

      const iqamaNumber    = String(raw.iqama_number    || '').trim() || null;
      const passportNumber = String(raw.passport_number || '').trim() || null;
      const employeeNumber = String(raw.employee_number || '').trim() || null;

      const toNum = (v) => {
        if (v === '' || v === undefined || v === null) return null;
        const n = Number(v);
        return Number.isNaN(n) ? null : n;
      };

      const basicSalary        = toNum(raw.basic_salary);
      const housingAllowance   = toNum(raw.housing_allowance);
      const transportAllowance = toNum(raw.transport_allowance);
      const otherAllowances    = toNum(raw.other_allowances);

      if (raw.basic_salary !== undefined && raw.basic_salary !== '' && basicSalary === null) {
        skipped.push({ row: i + 1, reason: 'Invalid basic_salary' });
        continue;
      }

      let existing = null;
      if (iqamaNumber) {
        const { rows } = await query(
          `SELECT id FROM employees WHERE company_id = $1 AND iqama_number = $2 LIMIT 1`,
          [company_id, iqamaNumber]
        );
        existing = rows[0] || null;
      }
      if (!existing && passportNumber) {
        const { rows } = await query(
          `SELECT id FROM employees WHERE company_id = $1 AND passport_number = $2 LIMIT 1`,
          [company_id, passportNumber]
        );
        existing = rows[0] || null;
      }
      if (!existing && employeeNumber) {
        const { rows } = await query(
          `SELECT id FROM employees WHERE company_id = $1 AND employee_number = $2 LIMIT 1`,
          [company_id, employeeNumber]
        );
        existing = rows[0] || null;
      }

      if (existing) {
        await query(
          `UPDATE employees
             SET employee_number        = COALESCE($2, employee_number),
                 full_name              = $3,
                 nationality            = COALESCE($4, nationality),
                 job_title              = COALESCE($5, job_title),
                 department             = COALESCE($6, department),
                 basic_salary           = COALESCE($7, basic_salary),
                 housing_allowance      = COALESCE($8, housing_allowance),
                 transport_allowance    = COALESCE($9, transport_allowance),
                 other_allowances       = COALESCE($10, other_allowances),
                 iqama_number           = COALESCE($11, iqama_number),
                 iqama_expiry           = COALESCE($12, iqama_expiry),
                 passport_number        = COALESCE($13, passport_number),
                 passport_expiry        = COALESCE($14, passport_expiry),
                 bank_name              = COALESCE($15, bank_name),
                 bank_account           = COALESCE($16, bank_account),
                 iban                   = COALESCE($17, iban)
           WHERE id = $18 AND company_id = $1`,
          [
            company_id, employeeNumber, fullName,
            String(raw.nationality || '').trim() || null,
            String(raw.job_title   || '').trim() || null,
            String(raw.department  || '').trim() || null,
            basicSalary, housingAllowance, transportAllowance, otherAllowances,
            iqamaNumber, String(raw.iqama_expiry    || '').trim() || null,
            passportNumber, String(raw.passport_expiry || '').trim() || null,
            String(raw.bank_name    || '').trim() || null,
            String(raw.bank_account || '').trim() || null,
            String(raw.iban         || '').trim() || null,
            existing.id
          ]
        );
        updated += 1;
      } else {
        await query(
          `INSERT INTO employees
             (company_id, employee_number, full_name, nationality, job_title, department,
              basic_salary, housing_allowance, transport_allowance, other_allowances,
              iqama_number, iqama_expiry, passport_number, passport_expiry,
              bank_name, bank_account, iban, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active')`,
          [
            company_id, employeeNumber, fullName,
            String(raw.nationality || '').trim() || null,
            String(raw.job_title   || '').trim() || null,
            String(raw.department  || '').trim() || null,
            basicSalary, housingAllowance ?? 0, transportAllowance ?? 0, otherAllowances ?? 0,
            iqamaNumber, String(raw.iqama_expiry    || '').trim() || null,
            passportNumber, String(raw.passport_expiry || '').trim() || null,
            String(raw.bank_name    || '').trim() || null,
            String(raw.bank_account || '').trim() || null,
            String(raw.iban         || '').trim() || null,
          ]
        );
        created += 1;
      }
    }

    return reply.send({ created, updated, skipped_count: skipped.length, skipped });
  });

  // ── GET /api/hr/employees/search ─────────────────────────────
  app.get('/employees/search', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { q = '' } = request.query;
    const { rows } = await query(
      `SELECT id, full_name, employee_number, department, bank_account, bank_name, iban
       FROM employees
       WHERE company_id = $1
         AND (full_name ILIKE $2 OR employee_number::text ILIKE $2)
         AND status = 'active'
       ORDER BY full_name LIMIT 10`,
      [company_id, `%${q}%`]
    );
    return { data: rows };
  });

  // ── GET /api/hr/employees/:id ─────────────────────────────────
  app.get('/employees/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT * FROM employees WHERE id = $1 AND company_id = $2`,
      [request.params.id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Employee not found' });
    return rows[0];
  });

  // ── PATCH /api/hr/employees/:id ───────────────────────────────
  app.patch('/employees/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const allowed = ['employee_number','full_name','nationality','job_title','department',
      'basic_salary','housing_allowance','transport_allowance','other_allowances',
      'iqama_number','iqama_expiry','passport_number','passport_expiry',
      'contract_start','contract_end','status','notes',
      'bank_account','bank_name','iban'];
    const updates = [];
    const params = [];
    let p = 1;
    for (const key of allowed) {
      if (request.body[key] !== undefined) {
        updates.push(`${key} = $${p++}`);
        params.push(request.body[key]);
      }
    }
    if (!updates.length) return reply.status(400).send({ error: 'No valid fields' });
    params.push(request.params.id, company_id);
    const { rows } = await query(
      `UPDATE employees SET ${updates.join(', ')} WHERE id = $${p++} AND company_id = $${p} RETURNING *`,
      params
    );
    if (!rows.length) return reply.status(404).send({ error: 'Employee not found' });
    return rows[0];
  });

  // ── GET /api/hr/employees/:id/documents ───────────────────────
  app.get('/employees/:id/documents', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT * FROM employee_documents WHERE employee_id = $1 AND company_id = $2 ORDER BY created_at DESC`,
      [request.params.id, company_id]
    );
    return { data: rows };
  });

  // ── POST /api/hr/employees/:id/documents ──────────────────────
  app.post('/employees/:id/documents', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['doc_type', 'file_name', 'file_data'],
        properties: {
          doc_type:  { type: 'string', enum: ['iqama', 'passport', 'photo', 'contract', 'other'] },
          file_name: { type: 'string' },
          file_data: { type: 'string' }, // base64
        }
      }
    }
  }, async (request, reply) => {
    const { company_id, id: _uploaded_by } = request.user;
    const uploaded_by = safeUUID(_uploaded_by);
    const { doc_type, file_name, file_data } = request.body;
    const employee_id = request.params.id;

    // Verify employee belongs to this company
    const { rows: empRows } = await query(
      `SELECT id FROM employees WHERE id = $1 AND company_id = $2`,
      [employee_id, company_id]
    );
    if (!empRows.length) return reply.status(404).send({ error: 'Employee not found' });

    // Sanitize file name
    const safeName = path.basename(file_name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const uploadDir = `/var/www/tarsyn-core/uploads/hr-documents/${employee_id}`;
    fs.mkdirSync(uploadDir, { recursive: true });

    const filePath = path.join(uploadDir, safeName);
    const buf = Buffer.from(file_data, 'base64');
    fs.writeFileSync(filePath, buf);

    const file_url = `/uploads/hr-documents/${employee_id}/${safeName}`;

    const { rows } = await query(
      `INSERT INTO employee_documents (company_id, employee_id, doc_type, file_name, file_url, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [company_id, employee_id, doc_type, safeName, file_url, uploaded_by || null]
    );
    return reply.status(201).send(rows[0]);
  });

  // ── DELETE /api/hr/employees/:id/documents/:docId ─────────────
  app.delete('/employees/:id/documents/:docId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id: employee_id, docId } = request.params;

    const { rows } = await query(
      `DELETE FROM employee_documents WHERE id = $1 AND employee_id = $2 AND company_id = $3 RETURNING *`,
      [docId, employee_id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Document not found' });

    // Optionally delete file from disk
    try {
      const doc = rows[0];
      const filePath = `/var/www/tarsyn-core${doc.file_url}`;
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_e) { /* non-critical */ }

    return { success: true };
  });

  // ── GET /api/hr/attendance ────────────────────────────────────
  app.get('/attendance', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const month = parseInt(request.query.month, 10) || new Date().getMonth() + 1;
    const year  = parseInt(request.query.year,  10) || new Date().getFullYear();
    const { rows } = await query(
      `SELECT ar.*, e.full_name, e.employee_number, e.department
       FROM attendance_records ar
       JOIN employees e ON e.id = ar.employee_id
       WHERE ar.company_id = $1
         AND EXTRACT(MONTH FROM ar.attendance_date) = $2
         AND EXTRACT(YEAR  FROM ar.attendance_date) = $3
       ORDER BY ar.attendance_date, e.full_name`,
      [company_id, month, year]
    );
    return { data: rows };
  });

  // ── POST /api/hr/attendance/bulk ──────────────────────────────
  app.post('/attendance/bulk', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['records'],
        properties: {
          records: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['employee_id', 'attendance_date', 'status'],
              properties: {
                employee_id:     { type: 'string' },
                attendance_date: { type: 'string' },
                status:          { type: 'string', enum: ['present', 'absent', 'half_day', 'leave', 'holiday'] },
                overtime_hours:  { type: 'number' },
                notes:           { type: 'string' },
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { company_id, id: _recorded_by } = request.user;
    const recorded_by = safeUUID(_recorded_by);
    const { records } = request.body;
    let upserted = 0;
    const errors = [];

    for (const rec of records) {
      try {
        await query(
          `INSERT INTO attendance_records
             (company_id, employee_id, attendance_date, status, overtime_hours, notes, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (company_id, employee_id, attendance_date) DO UPDATE
             SET status = EXCLUDED.status,
                 overtime_hours = EXCLUDED.overtime_hours,
                 notes = EXCLUDED.notes,
                 recorded_by = EXCLUDED.recorded_by`,
          [
            company_id,
            rec.employee_id,
            rec.attendance_date,
            rec.status,
            rec.overtime_hours || 0,
            rec.notes || null,
            recorded_by || null
          ]
        );
        upserted++;
      } catch (err) {
        errors.push({ employee_id: rec.employee_id, date: rec.attendance_date, error: err.message });
      }
    }

    return reply.status(201).send({ upserted, error_count: errors.length, errors });
  });

  // ── GET /api/hr/attendance/summary ────────────────────────────
  app.get('/attendance/summary', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const month = parseInt(request.query.month, 10) || new Date().getMonth() + 1;
    const year  = parseInt(request.query.year,  10) || new Date().getFullYear();
    const { rows } = await query(
      `SELECT
         e.id AS employee_id,
         e.full_name,
         e.employee_number,
         e.department,
         COUNT(*) FILTER (WHERE ar.status = 'present')  AS days_present,
         COUNT(*) FILTER (WHERE ar.status = 'absent')   AS days_absent,
         COUNT(*) FILTER (WHERE ar.status = 'half_day') AS days_half,
         COUNT(*) FILTER (WHERE ar.status = 'leave')    AS days_leave,
         COUNT(*) FILTER (WHERE ar.status = 'holiday')  AS days_holiday,
         COALESCE(SUM(ar.overtime_hours), 0)            AS total_overtime_hours
       FROM employees e
       LEFT JOIN attendance_records ar
         ON ar.employee_id = e.id
         AND ar.company_id = $1
         AND EXTRACT(MONTH FROM ar.attendance_date) = $2
         AND EXTRACT(YEAR  FROM ar.attendance_date) = $3
       WHERE e.company_id = $1 AND e.status = 'active'
       GROUP BY e.id, e.full_name, e.employee_number, e.department
       ORDER BY e.full_name`,
      [company_id, month, year]
    );
    return { data: rows, month, year };
  });

  // ── GET /api/hr/payroll ───────────────────────────────────────
  app.get('/payroll', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT pr.*,
              u.email AS approved_by_email,
              (SELECT COUNT(*) FROM payroll_items pi WHERE pi.payroll_run_id = pr.id) AS item_count
       FROM payroll_runs pr
       LEFT JOIN users u ON u.id = pr.approved_by
       WHERE pr.company_id = $1
       ORDER BY pr.year DESC, pr.month DESC`,
      [company_id]
    );
    return { data: rows };
  });

  // ── POST /api/hr/payroll ──────────────────────────────────────
  app.post('/payroll', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['month', 'year'],
        properties: {
          month: { type: 'integer', minimum: 1, maximum: 12 },
          year:  { type: 'integer' },
          notes: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { month, year, notes } = request.body;

    const { rows: existing } = await query(
      `SELECT id FROM payroll_runs WHERE company_id = $1 AND month = $2 AND year = $3`,
      [company_id, month, year]
    );
    if (existing.length) {
      return reply.status(409).send({ error: `Payroll run for ${month}/${year} already exists` });
    }

    const { rows: employees } = await query(
      `SELECT * FROM employees WHERE company_id = $1 AND status = 'active' ORDER BY full_name`,
      [company_id]
    );

    const { rows: runRows } = await query(
      `INSERT INTO payroll_runs (company_id, month, year, status, notes, total_basic, total_allowances, total_deductions, total_net)
       VALUES ($1, $2, $3, 'draft', $4, 0, 0, 0, 0) RETURNING *`,
      [company_id, month, year, notes || null]
    );
    const run = runRows[0];

    let totalBasic = 0, totalAllowances = 0, totalNet = 0;
    for (const emp of employees) {
      const basic      = parseFloat(emp.basic_salary      || 0);
      const allowances = parseFloat(emp.housing_allowance   || 0) +
                         parseFloat(emp.transport_allowance || 0) +
                         parseFloat(emp.other_allowances    || 0);
      const net = basic + allowances;
      totalBasic      += basic;
      totalAllowances += allowances;
      totalNet        += net;
      await query(
        `INSERT INTO payroll_items
           (payroll_run_id, employee_id, basic_salary, housing_allowance, transport_allowance,
            other_allowances, advance_deduction, other_deductions, net_salary, payment_method)
         VALUES ($1,$2,$3,$4,$5,$6,0,0,$7,'bank_transfer')`,
        [run.id, emp.id, basic, emp.housing_allowance || 0, emp.transport_allowance || 0,
         emp.other_allowances || 0, net]
      );
    }

    await query(
      `UPDATE payroll_runs SET total_basic=$1, total_allowances=$2, total_deductions=0, total_net=$3 WHERE id=$4`,
      [totalBasic, totalAllowances, totalNet, run.id]
    );

    return reply.status(201).send({
      ...run,
      total_basic: totalBasic,
      total_allowances: totalAllowances,
      total_net: totalNet,
      item_count: employees.length
    });
  });

  // ── GET /api/hr/payroll/:id ───────────────────────────────────
  app.get('/payroll/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT pr.*, u.email AS approved_by_email
       FROM payroll_runs pr LEFT JOIN users u ON u.id = pr.approved_by
       WHERE pr.id = $1 AND pr.company_id = $2`,
      [request.params.id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Payroll run not found' });
    const run = rows[0];

    const { rows: items } = await query(
      `SELECT pi.*, e.full_name, e.job_title, e.department
       FROM payroll_items pi
       JOIN employees e ON e.id = pi.employee_id
       WHERE pi.payroll_run_id = $1
       ORDER BY e.full_name`,
      [request.params.id]
    );
    run.items = items;
    return run;
  });

  // ── PATCH /api/hr/payroll/:id ─────────────────────────────────
  app.patch('/payroll/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'submitted', 'approved', 'paid'] },
          notes:  { type: 'string' },
          items:  { type: 'array' },
        }
      }
    }
  }, async (request, reply) => {
    const { company_id, id: _puid, role } = request.user;
    const user_id = safeUUID(_puid);
    const { status, notes, items } = request.body;

    // Role check for approved/paid transitions
    if (status === 'approved' || status === 'paid') {
      if (!FINANCE_ROLES.includes(role)) {
        return reply.status(403).send({ error: `Only finance/admin roles can mark payroll as ${status}` });
      }
    }

    const { rows } = await query(
      `SELECT * FROM payroll_runs WHERE id = $1 AND company_id = $2`,
      [request.params.id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Not found' });

    // Update individual items if provided
    if (items?.length) {
      for (const item of items) {
        const advance = parseFloat(item.advance_deduction || 0);
        const other   = parseFloat(item.other_deductions  || 0);
        await query(
          `UPDATE payroll_items SET advance_deduction=$1, other_deductions=$2, notes=$3,
           net_salary = basic_salary + housing_allowance + transport_allowance + other_allowances - $1 - $2
           WHERE id=$4`,
          [advance, other, item.notes || null, item.id]
        );
      }
      const { rows: totals } = await query(
        `SELECT SUM(basic_salary) AS b,
                SUM(housing_allowance+transport_allowance+other_allowances) AS a,
                SUM(advance_deduction+other_deductions) AS d,
                SUM(net_salary) AS n
         FROM payroll_items WHERE payroll_run_id = $1`,
        [request.params.id]
      );
      await query(
        `UPDATE payroll_runs SET total_basic=$1, total_allowances=$2, total_deductions=$3, total_net=$4 WHERE id=$5`,
        [totals[0].b || 0, totals[0].a || 0, totals[0].d || 0, totals[0].n || 0, request.params.id]
      );
    }

    // Build SET clause
    const setFields = [];
    const params    = [];
    let p = 1;

    if (status) {
      setFields.push(`status = $${p++}`);
      params.push(status);

      if (status === 'submitted') {
        setFields.push(`submitted_by = $${p++}`, `submitted_at = NOW()`);
        params.push(user_id);
      }
      if (status === 'approved') {
        setFields.push(`approved_by = $${p++}`, `approved_at = NOW()`);
        params.push(user_id);
      }
    }
    if (notes !== undefined) {
      setFields.push(`notes = $${p++}`);
      params.push(notes);
    }

    let updated_run = rows[0];
    if (setFields.length) {
      params.push(request.params.id, company_id);
      const { rows: updated } = await query(
        `UPDATE payroll_runs SET ${setFields.join(', ')} WHERE id = $${p++} AND company_id = $${p} RETURNING *`,
        params
      );
      if (updated && updated[0]) updated_run = updated[0];

      // Post-status notifications
      if (status === 'submitted' && updated_run) {
        try { await notifyPayrollSubmitted(updated_run); } catch (_e) { /* non-critical */ }
      }

      if (status === 'approved' && updated_run) {
        // Email all employees
        try {
          const { rows: payItems } = await query(
            `SELECT pi.net_salary, pi.basic_salary, e.full_name, e.email
             FROM payroll_items pi
             JOIN employees e ON e.id = pi.employee_id
             WHERE pi.payroll_run_id = $1 AND e.email IS NOT NULL`,
            [request.params.id]
          );
          const periodLabel = (updated_run.month ? updated_run.month + '/' + updated_run.year : 'this period');
          for (const item of payItems) {
            const net = Number(item.net_salary || item.basic_salary || 0).toLocaleString();
            await queueEmail({
              company_id,
              to: item.email,
              subject: '[Netaj ERP] Your Payroll Has Been Approved — ' + periodLabel,
              body_html: emailTemplate('Payroll Approved',
                '<p>Dear ' + item.full_name + ',</p>' +
                '<p>Your payroll for <strong>' + periodLabel + '</strong> has been <span style="color:#166534;font-weight:bold">approved</span>.</p>' +
                '<table style="font-size:14px;margin-top:12px"><tr><td style="padding:6px;color:#6b7280">Net Salary:</td><td style="padding:6px;font-weight:bold;font-size:18px">' + net + ' SAR</td></tr></table>' +
                '<p style="font-size:12px;color:#9ca3af;margin-top:16px">If you have questions, please contact HR.</p>'
              ),
              transaction_type: 'payroll_approved',
              priority: 'normal',
            });
          }
        } catch (_e) { /* non-critical */ }
        try { await notifyPayrollApproved(updated_run); } catch (_e2) { /* non-critical */ }
      }
    }

    return updated_run;
  });

  // ── GET /api/hr/advances ──────────────────────────────────────
  app.get('/advances', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { status } = request.query;
    const conditions = ['a.company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (status) { conditions.push(`a.status = $${p++}`); params.push(status); }
    const { rows } = await query(
      `SELECT a.*, u.email AS user_email
       FROM employee_cash_advances a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC`,
      params
    );
    return { data: rows };
  });

  // ── POST /api/hr/advances ─────────────────────────────────────
  app.post('/advances', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount:          { type: 'number' },
          purpose:         { type: 'string' },
          employee_name:   { type: 'string' },
          payment_method:  { type: 'string' },
          currency:        { type: 'string' },
          notes:           { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { company_id, id: _uid } = request.user;
    const user_id = safeUUID(_uid);
    const b = request.body;
    const { rows: cnt } = await query(
      `SELECT COUNT(*) AS c FROM employee_cash_advances WHERE company_id = $1`,
      [company_id]
    );
    const n = parseInt(cnt[0].c, 10) + 1;
    const advance_number = `ADV-${new Date().getFullYear()}-${String(n).padStart(4,'0')}`;
    const { rows } = await query(
      `INSERT INTO employee_cash_advances
         (company_id, user_id, amount, purpose, status, employee_name, payment_method, currency, notes, advance_number)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9)
       RETURNING *`,
      [company_id, user_id, b.amount, b.purpose||null, b.employee_name||null,
       b.payment_method||'cash', b.currency||'SAR', b.notes||null, advance_number]
    );
    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/hr/advances/:id ────────────────────────────────
  app.patch('/advances/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending','approved','disbursed','settled','rejected'] },
          notes:  { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { company_id, id: _uid } = request.user;
    const user_id = safeUUID(_uid);
    const { status, notes } = request.body;
    const updates = [];
    const params  = [];
    let p = 1;
    if (status) {
      updates.push(`status = $${p++}`);
      params.push(status);
      if (status === 'approved') {
        updates.push(`approved_by = $${p++}`, `approved_at = NOW()`);
        params.push(user_id);
      }
    }
    if (notes !== undefined) { updates.push(`notes = $${p++}`); params.push(notes); }
    if (!updates.length) return reply.status(400).send({ error: 'No valid fields' });
    updates.push(`updated_at = NOW()`);
    params.push(request.params.id, company_id);
    const { rows } = await query(
      `UPDATE employee_cash_advances SET ${updates.join(', ')} WHERE id = $${p++} AND company_id = $${p} RETURNING *`,
      params
    );
    if (!rows.length) return reply.status(404).send({ error: 'Advance not found' });
    return rows[0];
  });

  // ── GET /api/hr/expiry-alerts ─────────────────────────────────
  app.get('/expiry-alerts', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, full_name, job_title, department,
              iqama_number, iqama_expiry,
              passport_number, passport_expiry,
              CASE
                WHEN iqama_expiry IS NOT NULL THEN (iqama_expiry - CURRENT_DATE)
                ELSE NULL
              END AS iqama_days_left,
              CASE
                WHEN passport_expiry IS NOT NULL THEN (passport_expiry - CURRENT_DATE)
                ELSE NULL
              END AS passport_days_left
       FROM employees
       WHERE company_id = $1
         AND status = 'active'
         AND (
           (iqama_expiry IS NOT NULL AND iqama_expiry <= CURRENT_DATE + INTERVAL '180 days')
           OR
           (passport_expiry IS NOT NULL AND passport_expiry <= CURRENT_DATE + INTERVAL '180 days')
         )
       ORDER BY LEAST(
         COALESCE(iqama_expiry, '9999-12-31'::date),
         COALESCE(passport_expiry, '9999-12-31'::date)
       )`,
      [company_id]
    );

    const categorize = (days) => {
      if (days === null) return null;
      if (days <= 0)  return 'expired';
      if (days <= 30) return 'critical';
      if (days <= 90) return 'warning';
      return 'notice';
    };

    const alerts = rows.map(r => ({
      ...r,
      iqama_severity:    categorize(r.iqama_days_left),
      passport_severity: categorize(r.passport_days_left),
    }));

    const critical = alerts.filter(a =>
      a.iqama_severity === 'critical' || a.iqama_severity === 'expired' ||
      a.passport_severity === 'critical' || a.passport_severity === 'expired'
    ).length;
    const warning = alerts.filter(a =>
      a.iqama_severity === 'warning' || a.passport_severity === 'warning'
    ).length;

    return { alerts, critical_count: critical, warning_count: warning };
  });

  // ── GET /api/hr/dashboard-kpi ─────────────────────────────────
  app.get('/dashboard-kpi', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const [emps, activePayroll, pendingAdv] = await Promise.all([
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='active') AS active FROM employees WHERE company_id=$1`, [company_id]),
      query(`SELECT COUNT(*) AS cnt FROM payroll_runs WHERE company_id=$1 AND status='draft'`, [company_id]),
      query(`SELECT COUNT(*) AS cnt FROM employee_cash_advances WHERE company_id=$1 AND status='pending'`, [company_id]),
    ]);
    return {
      total_employees:     parseInt(emps.rows[0]?.total   || 0),
      active_employees:    parseInt(emps.rows[0]?.active  || 0),
      pending_payroll_runs:parseInt(activePayroll.rows[0]?.cnt || 0),
      pending_advances:    parseInt(pendingAdv.rows[0]?.cnt    || 0),
    };
  });

}
