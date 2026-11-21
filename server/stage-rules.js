// Stage transition rules of a pipeline.
//   transition_mode 'any'        — deals move freely between the pipeline's stages (default);
//   transition_mode 'restricted' — only the listed from → to pairs are allowed inside the pipeline;
//   lock_deals 1                 — deals of the pipeline cannot be moved to another pipeline.
//   rules_for_admins 1           — administrators follow the rules too (otherwise they are exempt in the web interface).
// The rules apply to employees and API keys.

export class RuleError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function createStageRules(db) {
  const stage = async id => await db.prepare('SELECT s.id,s.name,s.kind,s.pipeline_id,p.name pipeline_name,p.transition_mode,p.lock_deals,p.rules_for_admins FROM stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.id=?').get(id);

  const exempt = (from, admin) => admin && !from.rules_for_admins;

  // Returns an error message when the move is not allowed, otherwise null.
  // {admin: true} — the move is made by an administrator in the web interface.
  async function transitionError(fromStageId, toStageId, {admin = false} = {}) {
    if (!fromStageId || !toStageId || fromStageId === toStageId) return null;
    const [from, to] = [await stage(fromStageId), await stage(toStageId)];
    if (!from || !to || exempt(from, admin)) return null;
    if (from.pipeline_id !== to.pipeline_id) return from.lock_deals ? `Сделки воронки «${from.pipeline_name}» нельзя переносить в другую воронку` : null;
    if (from.transition_mode !== 'restricted') return null;
    const allowed = await db.prepare('SELECT 1 FROM stage_transitions WHERE from_stage_id=? AND to_stage_id=?').get(from.id, to.id);
    if (allowed) return null;
    const targets = (await db.prepare('SELECT s.name FROM stage_transitions t JOIN stages s ON s.id=t.to_stage_id WHERE t.from_stage_id=? ORDER BY s.sort_order,s.id').all(from.id)).map(row => `«${row.name}»`);
    return `Переход из этапа «${from.name}» в «${to.name}» запрещён правилами воронки. ${targets.length ? `Из этапа «${from.name}» можно перейти в: ${targets.join(', ')}` : `Из этапа «${from.name}» переходов нет`}`;
  }

  async function rulesFor(pipelineId) {
    const pipeline = await db.prepare('SELECT id,transition_mode,lock_deals,rules_for_admins FROM pipelines WHERE id=?').get(pipelineId);
    if (!pipeline) return null;
    const transitions = await db.prepare('SELECT t.from_stage_id,t.to_stage_id FROM stage_transitions t JOIN stages s ON s.id=t.from_stage_id WHERE s.pipeline_id=? ORDER BY t.from_stage_id,t.to_stage_id').all(pipelineId);
    return {pipeline_id: pipeline.id, mode: pipeline.transition_mode, lock_deals: !!pipeline.lock_deals, rules_for_admins: !!pipeline.rules_for_admins, transitions};
  }

  // Stage ids a deal currently in fromStageId may be moved to (its own stage excluded).
  async function allowedTargets(fromStageId, {admin = false} = {}) {
    const from = await stage(fromStageId);
    if (!from) return [];
    if (exempt(from, admin)) return (await db.prepare('SELECT id FROM stages WHERE id<>? ORDER BY pipeline_id,sort_order,id').all(from.id)).map(row => row.id);
    const own = from.transition_mode === 'restricted'
      ? (await db.prepare('SELECT to_stage_id id FROM stage_transitions WHERE from_stage_id=? ORDER BY to_stage_id').all(from.id)).map(row => row.id)
      : (await db.prepare('SELECT id FROM stages WHERE pipeline_id=? AND id<>? ORDER BY sort_order,id').all(from.pipeline_id, from.id)).map(row => row.id);
    if (from.lock_deals) return own;
    const other = (await db.prepare('SELECT id FROM stages WHERE pipeline_id<>? ORDER BY pipeline_id,sort_order,id').all(from.pipeline_id)).map(row => row.id);
    return [...own, ...other];
  }

  // input: {mode?: 'any'|'restricted', lock_deals?: boolean, rules_for_admins?: boolean, transitions?: [{from_stage_id,to_stage_id}] | {fromId: [toId,...]}}
  async function saveRules(pipelineId, input) {
    const current = await rulesFor(pipelineId);
    if (!current) throw new RuleError('Воронка не найдена', 404);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuleError('Передайте настройки переходов объектом');
    const mode = input.mode === undefined ? current.mode : input.mode;
    const lock = input.lock_deals === undefined ? current.lock_deals : input.lock_deals;
    if (!['any', 'restricted'].includes(mode)) throw new RuleError('mode: any или restricted');
    if (typeof lock !== 'boolean') throw new RuleError('lock_deals: true или false');
    const admins = input.rules_for_admins === undefined ? current.rules_for_admins : input.rules_for_admins;
    if (typeof admins !== 'boolean') throw new RuleError('rules_for_admins: true или false');
    let pairs = null;
    if (input.transitions !== undefined) {
      const raw = input.transitions;
      if (Array.isArray(raw)) pairs = raw.map(item => [Number(item?.from_stage_id), Number(item?.to_stage_id)]);
      else if (raw && typeof raw === 'object') pairs = Object.entries(raw).flatMap(([from, targets]) => Array.isArray(targets) ? targets.map(to => [Number(from), Number(to)]) : [[NaN, NaN]]);
      else throw new RuleError('transitions: список пар {from_stage_id, to_stage_id}');
      if (pairs.length > 10000) throw new RuleError('Слишком много переходов');
      const stageIds = new Set((await db.prepare('SELECT id FROM stages WHERE pipeline_id=?').all(pipelineId)).map(row => row.id));
      if (pairs.some(([from, to]) => !stageIds.has(from) || !stageIds.has(to))) throw new RuleError('Каждый переход должен соединять этапы этой воронки');
      if (pairs.some(([from, to]) => from === to)) throw new RuleError('Переход в тот же этап не нужен');
      pairs = [...new Map(pairs.map(pair => [pair.join(':'), pair])).values()];
    }
    await db.transaction(async () => {
      await db.prepare('UPDATE pipelines SET transition_mode=?,lock_deals=?,rules_for_admins=? WHERE id=?').run(mode, lock ? 1 : 0, admins ? 1 : 0, pipelineId);
      if (pairs) {
        await db.prepare('DELETE FROM stage_transitions WHERE from_stage_id IN (SELECT id FROM stages WHERE pipeline_id=?)').run(pipelineId);
        const insert = db.prepare('INSERT INTO stage_transitions (from_stage_id,to_stage_id) VALUES (?,?)');
        for (const [from, to] of pairs) await insert.run(from, to);
      }
    })();
    return rulesFor(pipelineId);
  }

  return {transitionError, rulesFor, allowedTargets, saveRules};
}
