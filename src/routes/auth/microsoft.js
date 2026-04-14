import { ConfidentialClientApplication } from '@azure/msal-node';
import { query } from '../../db.js';

const msalConfig = {
  auth: {
    clientId:     process.env.AZURE_CLIENT_ID,
    authority:    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
};

const REDIRECT_URI  = process.env.AZURE_REDIRECT_URI;
const FRONTEND_URL  = (process.env.FRONTEND_URL || 'https://netaj.co').replace(/\/+$/, '');
const SCOPES        = ['openid', 'profile', 'email', 'User.Read'];

export default async function microsoftRoutes(app) {

  // ── GET /api/auth/microsoft ───────────────────────────────────
  // Builds the Microsoft authorization URL and 302-redirects the browser
  app.get('/microsoft', async (request, reply) => {
    const cca = new ConfidentialClientApplication(msalConfig);

    const authUrl = await cca.getAuthCodeUrl({
      scopes:      SCOPES,
      redirectUri: REDIRECT_URI,
    });

    return reply.redirect(authUrl);
  });

  // ── GET /api/auth/microsoft/callback ─────────────────────────
  // Exchanges the auth code for tokens, looks up the user in the DB,
  // signs a Tarsyn JWT, and redirects the browser back to the frontend.
  app.get('/microsoft/callback', async (request, reply) => {
    const { code, error: oauthError } = request.query;

    if (oauthError || !code) {
      const msg = oauthError ?? 'no_code';
      app.log.warn({ oauthError: msg }, 'Microsoft OAuth error');
      return reply.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
    }

    let idTokenClaims;
    try {
      const cca = new ConfidentialClientApplication(msalConfig);
      const result = await cca.acquireTokenByCode({
        code,
        scopes:      SCOPES,
        redirectUri: REDIRECT_URI,
      });
      idTokenClaims = result.idTokenClaims;
    } catch (err) {
      app.log.error({ err }, 'MSAL token exchange failed');
      return reply.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
    }

    // preferred_username is typically the UPN (email) in Azure AD
    const email = (
      idTokenClaims.preferred_username ||
      idTokenClaims.email ||
      idTokenClaims.upn  ||
      ''
    ).toLowerCase().trim();

    if (!email) {
      app.log.warn({ idTokenClaims }, 'No email in Microsoft token claims');
      return reply.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
    }

    // Look up the user in our DB — must be pre-provisioned and active
    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.company_id, u.is_active,
              ur.role
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
       WHERE u.email = $1
       LIMIT 1`,
      [email]
    );

    const user = rows[0];

    if (!user || !user.is_active) {
      app.log.warn({ email }, 'Microsoft login: user not provisioned');
      return reply.redirect(`${FRONTEND_URL}/auth?error=not_provisioned`);
    }

    // Sign a Tarsyn JWT — same payload as POST /auth/login
    const token = app.jwt.sign(
      {
        sub:        user.id,
        email:      user.email,
        company_id: user.company_id,
        role:       user.role ?? 'user',
      },
      { expiresIn: '24h' }
    );

    // Hand the JWT to the frontend via query param
    return reply.redirect(`${FRONTEND_URL}/auth?token=${token}`);
  });
}
