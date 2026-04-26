// ============================================================
//  /api/sharepoint/* — debug + diagnostic endpoints for the
//  SharePoint upload integration.
//
//  After Phase 2 (per-site permission grant) we also wire each
//  real upload endpoint through services/sharepoint.js — at
//  which point /test-upload becomes optional but still useful
//  for ops to confirm auth is alive.
// ============================================================

import {
  uploadToSharePoint,
  sendSharePointError,
} from '../services/sharepoint.js';

export default async function sharePointRoutes(app) {

  // POST /api/sharepoint/test-upload
  // Body: { folderPath?: string, fileName?: string, text?: string }
  // Defaults to writing 'erp-uploader-alive.txt' under
  // <library>/Finance/__erp-test/ — a safe scratch path.
  app.post('/test-upload', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          folderPath: { type: 'string' },
          fileName:   { type: 'string' },
          text:       { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const folderPath = request.body?.folderPath ?? 'Finance/__erp-test';
    const fileName   = request.body?.fileName   ?? `erp-uploader-alive-${Date.now()}.txt`;
    const text       = request.body?.text       ?? `Test upload from ERP at ${new Date().toISOString()}`;

    try {
      const result = await uploadToSharePoint({
        folderPath,
        fileName,
        buffer: Buffer.from(text, 'utf8'),
        contentType: 'text/plain',
      });
      return reply.status(201).send({
        success: true,
        ...result,
        folderPath,
      });
    } catch (err) {
      return sendSharePointError(reply, err);
    }
  });
}
