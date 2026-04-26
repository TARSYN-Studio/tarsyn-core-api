// ============================================================
//  SharePoint upload service
//
//  Uses the dedicated ERP-SharePoint-Uploader Azure app:
//    - Sites.Selected (App permission)
//    - Granted write access on the /sites/Netaj site only
//
//  Auth pattern: ClientSecretCredential (app-only, no user
//  context) — same shape as services/email.js.
//
//  Public surface:
//    uploadToSharePoint({ folderPath, fileName, buffer, contentType })
//      → { webUrl, itemId, name, size }
//
//    Auto-creates parent folders. Folder paths are slash-separated
//    relative to the document library root, e.g.
//      'Finance/FR-2026-00072'
//      'Logistics/PROD-2026-00012-shipment-1'
//      'Production/WS-1764837999511'
//
//    Throws SharePointError with .statusCode for the route layer to
//    surface as a clean HTTP response.
// ============================================================

import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider }
  from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';

export class SharePointError extends Error {
  constructor(statusCode, message, payload = null) {
    super(message);
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

let _graphClient = null;
let _resolvedSite = null;   // { siteId, driveId, libraryName }

function getGraphClient() {
  if (_graphClient) return _graphClient;
  const tenant = process.env.AZURE_SP_TENANT_ID;
  const clientId = process.env.AZURE_SP_CLIENT_ID;
  const clientSecret = process.env.AZURE_SP_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) {
    throw new SharePointError(
      500,
      'SharePoint Azure credentials missing (AZURE_SP_TENANT_ID / _CLIENT_ID / _CLIENT_SECRET)'
    );
  }
  const credential = new ClientSecretCredential(tenant, clientId, clientSecret);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
  _graphClient = Client.initWithMiddleware({ authProvider });
  return _graphClient;
}

/**
 * One-time resolve of the SharePoint site + the named document
 * library inside it. Cached for the process lifetime.
 *
 * SHAREPOINT_SITE_URL  = https://netaj.sharepoint.com/sites/Netaj
 * SHAREPOINT_LIBRARY   = NatejERPFileStorage
 */
async function resolveDrive() {
  if (_resolvedSite) return _resolvedSite;

  const siteUrl = process.env.SHAREPOINT_SITE_URL;
  const libraryName = process.env.SHAREPOINT_LIBRARY;
  if (!siteUrl || !libraryName) {
    throw new SharePointError(
      500,
      'SHAREPOINT_SITE_URL and SHAREPOINT_LIBRARY env vars required'
    );
  }

  // Parse hostname + site path from SHAREPOINT_SITE_URL.
  let hostname;
  let sitePath;
  try {
    const u = new URL(siteUrl);
    hostname = u.hostname;
    sitePath = u.pathname.replace(/\/$/, ''); // /sites/Netaj
  } catch {
    throw new SharePointError(500, `SHAREPOINT_SITE_URL is not a valid URL: ${siteUrl}`);
  }

  const client = getGraphClient();

  // Resolve the site by hostname + relative path.
  // Graph supports: GET /sites/{hostname}:{site-path}
  let site;
  try {
    site = await client.api(`/sites/${hostname}:${sitePath}`).get();
  } catch (err) {
    throw new SharePointError(
      err.statusCode ?? 500,
      `Could not resolve SharePoint site '${siteUrl}': ${err.message}`,
      { hint: 'Confirm the URL is reachable and the app has Sites.Selected access to this site.' }
    );
  }

  // List drives (= libraries) on the site, find the one matching SHAREPOINT_LIBRARY.
  let drive;
  try {
    const drives = await client.api(`/sites/${site.id}/drives`).get();
    drive = (drives.value ?? []).find((d) => d.name === libraryName);
  } catch (err) {
    throw new SharePointError(
      err.statusCode ?? 500,
      `Could not list drives on site: ${err.message}`
    );
  }
  if (!drive) {
    throw new SharePointError(
      404,
      `Document library '${libraryName}' not found on site '${siteUrl}'`,
      { hint: 'Check the library name on the SharePoint site (gear icon → Site Contents).' }
    );
  }

  _resolvedSite = { siteId: site.id, driveId: drive.id, libraryName: drive.name };
  return _resolvedSite;
}

/**
 * Upload a file to SharePoint. Auto-creates intermediate folders.
 *
 * @param {object}   opts
 * @param {string}   opts.folderPath   — slash-separated, no leading slash
 *                                        (e.g. 'Finance/FR-2026-00072')
 * @param {string}   opts.fileName     — final filename (e.g. 'remittance.pdf')
 * @param {Buffer}   opts.buffer       — file bytes
 * @param {string}   [opts.contentType] — defaults to 'application/octet-stream'
 *
 * @returns {{ webUrl, itemId, name, size }}
 *
 * Notes:
 *  - Files >4MB need a chunked upload session. This helper uses the
 *    simple PUT path which Graph accepts up to ~250MB but is most
 *    reliable under 4MB. Large uploads can be added later by
 *    branching on buffer.length.
 */
export async function uploadToSharePoint({
  folderPath,
  fileName,
  buffer,
  contentType = 'application/octet-stream',
}) {
  if (!fileName) throw new SharePointError(400, 'fileName is required');
  if (!Buffer.isBuffer(buffer)) {
    throw new SharePointError(400, 'buffer must be a Buffer');
  }

  const { driveId } = await resolveDrive();
  const safeFolder = (folderPath ?? '').replace(/^\/+|\/+$/g, '');
  const safeName = fileName.replace(/[\\/]/g, '_');
  // Path-encode each segment but preserve slashes between them.
  const fullPath = (safeFolder ? safeFolder + '/' : '') + safeName;
  const encoded = fullPath.split('/').map(encodeURIComponent).join('/');

  const client = getGraphClient();

  let item;
  try {
    item = await client
      .api(`/drives/${driveId}/root:/${encoded}:/content`)
      .header('Content-Type', contentType)
      .put(buffer);
  } catch (err) {
    throw new SharePointError(
      err.statusCode ?? 500,
      `SharePoint upload failed: ${err.message}`,
      { folderPath: safeFolder, fileName: safeName }
    );
  }

  return {
    webUrl: item.webUrl,
    itemId: item.id,
    name: item.name,
    size: item.size,
  };
}

/**
 * Convert a SharePoint helper error into a Fastify reply, mirroring
 * the sendReversalError pattern used elsewhere in the API.
 */
export function sendSharePointError(reply, err) {
  if (err instanceof SharePointError) {
    const body = { error: err.message };
    if (err.payload) Object.assign(body, err.payload);
    return reply.status(err.statusCode).send(body);
  }
  throw err;
}
