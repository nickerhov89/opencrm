import React, {useEffect, useMemo, useState} from 'react';
import {CalendarDays, RotateCcw, X} from 'lucide-react';
import './deal-filter.css';

export const emptyDealFilter={preset:'',name:'',owner:'',source:'',tag:'',stageIds:[],amountFrom:'',amountTo:'',createdFrom:'',createdTo:''};

export function matchDealFilter(deal,filter,tasks,currentUserId,now=Date.now()){
  const text=value=>String(value||'').toLocaleLowerCase('ru-RU');
  const includes=(value,query)=>!query||text(value).includes(text(query).trim());
  if(!includes(deal.name,filter.name)||!includes(deal.source,filter.source)||!includes(deal.tags,filter.tag))return false;
  if(filter.owner&&String(deal.owner_id)!==String(filter.owner))return false;
  if(filter.stageIds?.length&&!filter.stageIds.includes(Number(deal.stage_id)))return false;
  if(filter.amountFrom!==''&&Number(deal.amount)<Number(filter.amountFrom))return false;
  if(filter.amountTo!==''&&Number(deal.amount)>Number(filter.amountTo))return false;
  const created=String(deal.created_at||'').slice(0,10);
  if(filter.createdFrom&&created<filter.createdFrom||filter.createdTo&&created>filter.createdTo)return false;
  if(filter.preset==='open'&&deal.kind!=='active'||filter.preset==='mine'&&(deal.kind!=='active'||Number(deal.owner_id)!==Number(currentUserId))||filter.preset==='won'&&deal.kind!=='won'||filter.preset==='lost'&&deal.kind!=='lost')return false;
  if(filter.preset==='noTasks'||filter.preset==='overdue'){
    const openCount=deal.open_tasks_count??tasks.filter(task=>Number(task.deal_id)===Number(deal.id)&&!task.completed_at).length;
    const overdueCount=deal.overdue_tasks_count??tasks.filter(task=>Number(task.deal_id)===Number(deal.id)&&!task.completed_at&&task.due_at&&new Date(task.due_at).getTime()<now).length;
    if(filter.preset==='noTasks'&&openCount>0||filter.preset==='overdue'&&overdueCount===0)return false;
  }
  return true;
}

const presets=[['open','Открытые сделки'],['mine','Только мои сделки'],['won','Успешно завершенные'],['lost','Нереализованные сделки'],['noTasks','Сделки без задач'],['overdue','Сделки с просроченными задачами']];

export default function DealFilter({filter,stages,users,deals,savedFilters=[],activeSavedFilterId,onApply,onReset,onClose,onSave,onDelete}){
  const [draft,setDraft]=useState(filter);
  const [saveName,setSaveName]=useState(''),[saving,setSaving]=useState(false);
  useEffect(()=>setDraft(filter),[filter]);
  const sources=useMemo(()=>[...new Set(deals.map(d=>String(d.source||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru')).slice(0,30),[deals]);
  const tags=useMemo(()=>{const counts=new Map();deals.forEach(d=>String(d.tags||'').split(',').map(x=>x.trim()).filter(Boolean).forEach(tag=>counts.set(tag,(counts.get(tag)||0)+1)));return [...counts].sort((a,b)=>b[1]-a[1]).slice(0,30)},[deals]);
  const set=(key,value)=>setDraft(old=>({...old,[key]:value,preset:key==='preset'?value:old.preset}));
  const toggleStage=id=>setDraft(old=>({...old,stageIds:old.stageIds.includes(id)?old.stageIds.filter(x=>x!==id):[...old.stageIds,id]}));
  return <><button className="deal-filter-scrim" aria-label="Закрыть фильтр" onClick={onClose}/><section className="deal-filter" aria-label="Фильтр сделок"><div className="deal-filter-columns"><div className="deal-filter-presets"><h3>БЫСТРЫЕ ФИЛЬТРЫ</h3>{presets.map(([key,label])=><button key={key} className={draft.preset===key?'selected':''} onClick={()=>{const next={...emptyDealFilter,preset:key};setDraft(next);onApply(next)}}><i className={'filter-dot '+key}/>{label}</button>)}<h3>МОИ ФИЛЬТРЫ</h3>{savedFilters.map(item=><div className="deal-saved-filter" key={item.id}><button className={activeSavedFilterId===item.id?'selected':''} onClick={()=>{setDraft(item.filter);onApply(item.filter,item.id)}} title={item.name}>{item.name}</button><button className="deal-saved-delete" aria-label={`Удалить фильтр ${item.name}`} title="Удалить фильтр" onClick={()=>onDelete(item.id)}><X size={13}/></button></div>)}<form className="deal-filter-save" onSubmit={async event=>{event.preventDefault();if(!saveName.trim()||saving)return;setSaving(true);try{const saved=await onSave(saveName.trim(),draft);if(saved)setSaveName('')}finally{setSaving(false)}}}><input aria-label="Название нового фильтра" placeholder="Название фильтра" value={saveName} maxLength={80} onChange={event=>setSaveName(event.target.value)}/><button type="submit" disabled={!saveName.trim()||saving}>Сохранить</button></form></div><div className="deal-filter-properties"><h3>СВОЙСТВА СДЕЛОК</h3><label>Название сделки<input value={draft.name} onChange={e=>set('name',e.target.value)} placeholder="Название сделки"/></label><label>Дата создания<div className="filter-date-pair"><CalendarDays size={16}/><input type="date" value={draft.createdFrom} max={draft.createdTo||undefined} onChange={e=>set('createdFrom',e.target.value)}/><span>—</span><input type="date" value={draft.createdTo} min={draft.createdFrom||undefined} onChange={e=>set('createdTo',e.target.value)}/></div></label><fieldset><legend>Этапы</legend>{stages.map(stage=><label className="filter-checkbox" key={stage.id}><input type="checkbox" checked={draft.stageIds.includes(stage.id)} onChange={()=>toggleStage(stage.id)}/><i style={{background:stage.color}}/>{stage.name}</label>)}</fieldset><label>Источник сделки<input list="deal-filter-sources" value={draft.source} onChange={e=>set('source',e.target.value)} placeholder="Все значения"/><datalist id="deal-filter-sources">{sources.map(source=><option key={source} value={source}/>)}</datalist></label><label>Менеджеры<select value={draft.owner} onChange={e=>set('owner',e.target.value)}><option value="">Все менеджеры</option>{users.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label>Бюджет, ₽<div className="filter-amount-pair"><input type="number" min="0" value={draft.amountFrom} onChange={e=>set('amountFrom',e.target.value)} placeholder="от"/><span>—</span><input type="number" min="0" value={draft.amountTo} onChange={e=>set('amountTo',e.target.value)} placeholder="до"/></div></label></div><div className="deal-filter-tags"><h3>ТЕГИ</h3><input value={draft.tag} onChange={e=>set('tag',e.target.value)} placeholder="Найти тег"/>{tags.length?<div className="deal-filter-tag-list">{tags.filter(([tag])=>!draft.tag||tag.toLocaleLowerCase('ru').includes(draft.tag.toLocaleLowerCase('ru'))).map(([tag,count])=><button key={tag} onClick={()=>set('tag',tag)}><span>{tag}</span><small>{count}</small></button>)}</div>:<p>Тегов пока нет</p>}</div></div><footer className="deal-filter-actions"><button onClick={()=>{setDraft(emptyDealFilter);onReset()}}><RotateCcw size={14}/> Сбросить</button><button className="deal-filter-close" onClick={onClose}><X size={15}/> Закрыть</button><button className="blue-btn" onClick={()=>onApply(draft)}>Применить</button></footer></section></>;
}
