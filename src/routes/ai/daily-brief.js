// ─────────────────────────────────────────────────────────────
// Tarsyn Core · AI daily brief
// POST /ai/daily-brief
//
// Generates one editorial sentence (≤20 words) summarizing the
// single most important thing the CEO should know, given live
// live context from the dashboard.
//
// Consumed by the Command Center hero in src/pages/Index.tsx.
// ─────────────────────────────────────────────────────────────
import { GoogleGenerativeAI } from '@google/generative-ai';

const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

let _client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_client) _client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _client;
}

// Minimal schema for the context payload — we accept anything and
// just forward to the prompt. The model tolerates arbitrary JSON.
function buildPrompt(lang, context) {
  const isAr = lang === 'ar';
  const system = isAr
    ? [
        'أنت مستشار استراتيجي لمدير تنفيذي سعودي يقود مصنع مطاط صناعي (مجموعة نتاج) في الخبر.',
        'اكتب جملة واحدة فقط، بحد أقصى ٢٠ كلمة، تلخّص أهم شيء يجب أن يعرفه المدير الآن.',
        'لا تكتب أي مقدمة، ولا تحية، ولا إيموجي، ولا اقتباسات.',
        'استند إلى السياق الحيّ أدناه فقط — لا تختلق أرقاماً.',
      ].join('\n')
    : [
        'You advise the CEO of Netaj Group, a Saudi rubber manufacturer in Khobar.',
        'Write ONE sentence only — max 20 words — that captures the single most important thing the CEO should know right now.',
        'No preamble. No greeting. No emoji. No quotation marks. No lead-in like "Today:".',
        'Ground the sentence in the live context below. Do NOT invent numbers not present in the context.',
      ].join('\n');

  const ctxBlock = `Context (JSON):\n${JSON.stringify(context ?? {}, null, 2)}`;
  return `${system}\n\n${ctxBlock}`;
}

export default async function routes(app) {
  app.post(
    '/ai/daily-brief',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const client = getClient();
      if (!client) {
        request.log.warn('GEMINI_API_KEY missing — returning empty brief');
        return reply.code(200).send({
          text: '',
          source: 'fallback',
          reason: 'GEMINI_API_KEY not configured on server',
        });
      }

      const { lang = 'en', context = {} } = request.body ?? {};
      const prompt = buildPrompt(lang, context);

      try {
        const model = client.getGenerativeModel({ model: MODEL_NAME });
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.45,
            // Generous ceiling — gemini-2.5-flash spends "thinking" tokens
            // silently before writing output. 1024 leaves plenty for the
            // single-sentence brief even after reasoning.
            maxOutputTokens: 1024,
            // Turn thinking OFF — we want a snap sentence, not multi-step
            // reasoning. Ignored silently by models that don't support it.
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
        const raw = result?.response?.text?.() ?? '';
        const text = String(raw)
          .trim()
          .replace(/^["'`]+|["'`]+$/g, '')
          .replace(/^Today[:,-]\s*/i, '')
          .replace(/\s+/g, ' ');
        return reply.code(200).send({
          text,
          source: 'gemini',
          model: MODEL_NAME,
        });
      } catch (err) {
        request.log.error({ err: err?.message || err }, 'gemini daily-brief failed');
        return reply.code(200).send({
          text: '',
          source: 'error',
          reason: err?.message || 'Gemini request failed',
        });
      }
    }
  );

  // Quick health probe so we can curl-verify without a JWT.
  app.get('/ai/daily-brief/health', async () => ({
    ok: true,
    configured: !!process.env.GEMINI_API_KEY,
    model: MODEL_NAME,
  }));
}
