// Server part: runs inside OpenCRM. ctx is described in docs/PLUGINS.md.
export async function activate(ctx) {
  // GET /api/plugins/hello-world/deal/:id — only for signed-in users.
  ctx.router.get('/deal/:id', async (req, res) => {
    const deal = await ctx.db.prepare('SELECT id,name,created_at FROM deals WHERE id=? AND deleted_at IS NULL').get(Number(req.params.id) || 0);
    if (!deal) return res.status(404).json({error: 'Сделка не найдена'});
    const opened = Number(await ctx.storage.get(`opened:${deal.id}`) || 0) + 1;
    await ctx.storage.set(`opened:${deal.id}`, opened);
    const days = Math.floor((Date.now() - Date.parse(deal.created_at.replace(' ', 'T') + 'Z')) / 864e5);
    res.json({deal_id: deal.id, days, opened});
  });

  ctx.router.get('/stats', async (_req, res) => {
    const stats = await ctx.db.prepare("SELECT (SELECT COUNT(*) FROM deals WHERE deleted_at IS NULL) deals, (SELECT COUNT(*) FROM inbox_leads WHERE status='pending') leads").get();
    res.json({...stats, stage_changes: Number(await ctx.storage.get('stage_changes') || 0)});
  });

  ctx.on('deal.stage_changed', async event => {
    await ctx.storage.set('stage_changes', Number(await ctx.storage.get('stage_changes') || 0) + 1);
    if (ctx.settings.logStages) await ctx.crm.addDealEvent(event.data.id, `сделка перешла на этап #${event.data.stage_id}`);
  });

  ctx.log.info('Пример плагина запущен');
  return () => ctx.log.info('Пример плагина остановлен');
}
