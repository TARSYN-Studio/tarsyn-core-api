/**
 * One-time script: creates the first admin (CEO) user for Netaj.
 * Run once: node scripts/create-admin.js
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

const COMPANY_ID = process.env.NETAJ_COMPANY_ID;
const EMAIL      = 'tarsyn.studio@gmail.com';
const PASSWORD   = 'TarsynCore2026!';   // change after first login
const FULL_NAME  = 'Tarsyn Admin';
const ROLE       = 'ceo';

async function main() {
  console.log('Creating admin user...');

  const hash = await bcrypt.hash(PASSWORD, 12);

  const { rows } = await pool.query(
    `INSERT INTO users (company_id, email, password_hash, full_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           full_name     = EXCLUDED.full_name,
           updated_at    = now()
     RETURNING id, email, full_name`,
    [COMPANY_ID, EMAIL, hash, FULL_NAME]
  );

  const user = rows[0];
  console.log('  User upserted:', user.email, '—', user.id);

  await pool.query(
    `INSERT INTO user_roles (user_id, company_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, company_id) DO UPDATE SET role = EXCLUDED.role`,
    [user.id, COMPANY_ID, ROLE]
  );

  console.log('  Role assigned:', ROLE);
  console.log('');
  console.log('Login credentials:');
  console.log('  Email:    ', EMAIL);
  console.log('  Password: ', PASSWORD);
  console.log('  Role:     ', ROLE);
  console.log('');
  console.log('Change the password after first login.');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
