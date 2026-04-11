import bcrypt from 'bcryptjs';
import { query } from '../db.js';

export default async function authRoutes(app) {

  // POST /api/auth/login
  app.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body;

    const { rows } = await query(
      `SELECT u.id, u.email, u.password_hash, u.full_name, u.company_id, u.is_active,
              ur.role
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
       WHERE u.email = $1
       LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    const user = rows[0];

    // Constant-time rejection — don't reveal whether email exists
    if (!user || !user.is_active) {
      await bcrypt.compare('dummy', '$2a$12$dummyhashtopreventtimingattacks00000000000000000000000');
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    const token = app.jwt.sign(
      {
        sub:        user.id,
        email:      user.email,
        company_id: user.company_id,
        role:       user.role ?? 'user',
      },
      { expiresIn: '24h' }
    );

    return {
      token,
      user: {
        id:         user.id,
        email:      user.email,
        full_name:  user.full_name,
        company_id: user.company_id,
        role:       user.role ?? 'user',
      },
    };
  });

  // GET /api/auth/me
  app.get('/me', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { sub: userId } = request.user;

    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.company_id, u.is_active,
              ur.role,
              c.name_en  AS company_name_en,
              c.name_ar  AS company_name_ar,
              c.slug     AS company_slug
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
       LEFT JOIN companies c   ON c.id = u.company_id
       WHERE u.id = $1`,
      [userId]
    );

    const user = rows[0];
    if (!user) return reply.status(404).send({ error: 'User not found' });

    return {
      id:         user.id,
      email:      user.email,
      full_name:  user.full_name,
      company_id: user.company_id,
      role:       user.role ?? 'user',
      company: {
        name_en: user.company_name_en,
        name_ar: user.company_name_ar,
        slug:    user.company_slug,
      },
    };
  });
}
