import React,{useEffect,useState} from 'react';
import {X} from 'lucide-react';
import './stage-transitions.css';

const pairKey=(from,to)=>`${from}:${to}`;

// Which stage a deal may be moved to from which: the matrix rows are "from", columns are "to".
export default function StageTransitions({pipelineId,pipelineName,stages,api,onError,onClose}){
  const [mode,setMode]=useState('any'),[lock,setLock]=useState(false),[pairs,setPairs]=useState(new Set()),[loaded,setLoaded]=useState(false),[saving,setSaving]=useState(false);
  useEffect(()=>{api(`/pipelines/${pipelineId}/transitions`).then(rules=>{setMode(rules.mode);setLock(rules.lock_deals);setPairs(new Set(rules.transitions.map(item=>pairKey(item.from_stage_id,item.to_stage_id))));setLoaded(true)}).catch(onError)},[pipelineId]);
  const toggle=(from,to)=>setPairs(current=>{const next=new Set(current),key=pairKey(from,to);if(next.has(key))next.delete(key);else next.add(key);return next});
  const fill=test=>setPairs(new Set(stages.flatMap((from,i)=>stages.filter((to,j)=>from.id!==to.id&&test(i,j,from,to)).map(to=>pairKey(from.id,to.id)))));
  const forwardOnly=()=>fill((i,j,from,to)=>from.kind==='active'&&(j>i||to.kind!=='active'));
  const save=async event=>{event.preventDefault();setSaving(true);try{await api(`/pipelines/${pipelineId}/transitions`,{method:'PUT',body:{mode,lock_deals:lock,transitions:[...pairs].map(key=>{const [from,to]=key.split(':').map(Number);return {from_stage_id:from,to_stage_id:to}})}});onClose()}catch(error){onError(error)}finally{setSaving(false)}};
  return <div className="designer-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div className="designer-drawer stage-rules-drawer">
    <header><h2>Правила переходов · {pipelineName}</h2><button type="button" onClick={onClose} title="Закрыть"><X size={19}/></button></header>
    <p>Правила действуют для сотрудников и интеграций по API. Администраторы могут переносить сделки без ограничений.</p>
    {loaded&&<form onSubmit={save}>
      <fieldset className="stage-rules-mode"><legend>Перемещение между этапами</legend>
        <label><input type="radio" name="stage-rules-mode" checked={mode==='any'} onChange={()=>setMode('any')}/> Свободно, в любой этап</label>
        <label><input type="radio" name="stage-rules-mode" checked={mode==='restricted'} onChange={()=>setMode('restricted')}/> Только по разрешённым переходам</label>
      </fieldset>
      <label className="stage-rules-lock"><input type="checkbox" checked={lock} onChange={event=>setLock(event.target.checked)}/> Запретить переносить сделки в другие воронки</label>
      {mode==='restricted'&&<>
        <div className="stage-rules-presets"><button type="button" onClick={forwardOnly}>Только вперёд</button><button type="button" onClick={()=>fill(()=>true)}>Разрешить все</button><button type="button" onClick={()=>setPairs(new Set())}>Снять все</button></div>
        <div className="stage-rules-table-wrap"><table className="stage-rules-table"><thead><tr><th>Из этапа ↓ / в этап →</th>{stages.map(stage=><th key={stage.id} title={stage.name}><span style={{borderBottomColor:stage.color}}>{stage.name}</span></th>)}</tr></thead>
          <tbody>{stages.map(from=><tr key={from.id}><th title={from.name}><span style={{borderLeftColor:from.color}}>{from.name}</span></th>{stages.map(to=><td key={to.id}>{from.id===to.id?<span className="stage-rules-self">—</span>:<input type="checkbox" aria-label={`${from.name} → ${to.name}`} checked={pairs.has(pairKey(from.id,to.id))} onChange={()=>toggle(from.id,to.id)}/>}</td>)}</tr>)}</tbody></table></div>
        <p className="stage-rules-hint">Новый этап не получает переходов автоматически: отметьте их здесь, иначе сделки нельзя будет перенести в него.</p>
      </>}
      <div className="designer-drawer-actions"><button type="button" onClick={onClose}>Отмена</button><button type="submit" className="blue-btn" disabled={saving}>СОХРАНИТЬ</button></div>
    </form>}
  </div></div>;
}
