import {createHash, timingSafeEqual} from 'node:crypto';

// Tilda sends each form as a POST (form-urlencoded or JSON) to the webhook address. When the
// address is added, Tilda sends test=test and expects HTTP 200.
const service = new Set(['tranid', 'formid', 'formname', 'api_key', 'cookies', 'test']);
const pick = (fields, names) => {
  for (const [key, value] of Object.entries(fields)) if (names.includes(key.toLowerCase()) && String(value).trim()) return String(value).trim();
  return '';
};
const digest = value => createHash('sha256').update(String(value)).digest();
const sameToken = (given, expected) => !!given && !!expected && timingSafeEqual(digest(given), digest(expected));

export function activate(ctx) {
  ctx.publicRouter.post('/hook', async (req, res) => {
    const fields = req.body && typeof req.body === 'object' ? req.body : {};
    const given = req.get('api_key') || req.get('x-api-key') || fields.api_key || req.query.token;
    if (!sameToken(given, ctx.settings.token)) return res.status(403).send('Неверный ключ');
    if (fields.test === 'test') return res.send('ok');
    const tranid = String(fields.tranid || '').slice(0, 100);
    // Tilda repeats a delivery when the answer is slow; the transaction id keeps one lead.
    if (tranid && await ctx.storage.get(`tran:${tranid}`)) return res.send('ok');
    const form = String(fields.formname || fields.formid || '').slice(0, 120);
    const lines = Object.entries(fields)
      .filter(([key]) => !service.has(key.toLowerCase()))
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    const lead = await ctx.crm.createLead({
      pipeline_id: ctx.settings.pipeline_id || undefined,
      title: [ctx.settings.title || 'Заявка с сайта', form].filter(Boolean).join(': '),
      contact_name: pick(fields, ['name', 'имя', 'fio', 'фио']),
      phone: pick(fields, ['phone', 'телефон', 'tel']),
      email: pick(fields, ['email', 'e-mail', 'почта']),
      company_name: pick(fields, ['company', 'компания']),
      website: req.get('referer') || '',
      source: [ctx.settings.source || 'Tilda', fields.utm_source].filter(Boolean).join(' / '),
      message: lines.join('\n'),
    });
    if (tranid) await ctx.storage.set(`tran:${tranid}`, {lead_id: lead.id, at: new Date().toISOString()});
    ctx.log.info(`Заявка #${lead.id}${form ? ` из формы «${form}»` : ''}`);
    res.send('ok');
  });
}
