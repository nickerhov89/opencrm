import React, {useEffect, useMemo, useState} from 'react';
import CustomValueInput from './CustomValueInput.jsx';
import './deal-list.css';
import {lossReasons} from './loss-reasons.js';
import {sortDeals} from './deal-table-sort.js';

const defaults=['name','contact','company','stage','amount'];
const money=value=>new Intl.NumberFormat('ru-RU').format(Number(value)||0)+' ₽';
const date=value=>value?new Date(value.replace(' ','T')).toLocaleDateString('ru-RU'):'—';

export default function DealTable({deals,onOpen,api,users,auth,onError,onBulk,customFields,columnsOpen,onCloseColumns,showPipeline=false}){
  const [columns,setColumns]=useState(defaults),[draft,setDraft]=useState(defaults);
  const [selected,setSelected]=useState([]),[action,setAction]=useState(''),[target,setTarget]=useState('');
  const [sort,setSort]=useState({key:'',direction:'asc'});
  const [taskTitle,setTaskTitle]=useState(''),[due,setDue]=useState(''),[stageOptions,setStageOptions]=useState([]),[lossReason,setLossReason]=useState(''),[fieldOptions,setFieldOptions]=useState([]),[fieldValue,setFieldValue]=useState(''),[tagMode,setTagMode]=useState('add'),[tags,setTags]=useState(''),[busy,setBusy]=useState(false);
  const definitions=useMemo(()=>[
    {key:'name',label:'НАЗВАНИЕ СДЕЛКИ'},
    {key:'contact',label:'ОСНОВНОЙ КОНТАКТ'},
    {key:'company',label:'КОМПАНИЯ КОНТАКТА'},
    {key:'stage',label:'ЭТАП СДЕЛКИ'},
    {key:'loss_reason',label:'ПРИЧИНА ОТКАЗА'},
    {key:'amount',label:'БЮДЖЕТ, ₽'},
    {key:'owner',label:'ОТВЕТСТВЕННЫЙ'},
    {key:'source',label:'ИСТОЧНИК'},
    {key:'tags',label:'ТЕГИ'},
    {key:'created',label:'ДАТА СОЗДАНИЯ'},
    {key:'updated',label:'ДАТА ИЗМЕНЕНИЯ'},
    {key:'pipeline',label:'ВОРОНКА'},
    ...customFields.filter(field=>field.entity_type==='deal').map(field=>({key:`field:${field.id}`,label:field.name.toUpperCase()}))
  ],[customFields]);
  useEffect(()=>{let active=true;api('/me/deal-columns').then(result=>{if(active)setColumns(result.columns)}).catch(onError);return()=>{active=false}},[auth.id]);
  useEffect(()=>{if(columnsOpen)setDraft(columns.filter(key=>definitions.some(def=>def.key===key)))},[columnsOpen,columns,definitions]);
  const validColumns=columns.filter(key=>definitions.some(def=>def.key===key));
  const visibleColumns=validColumns.length?validColumns:defaults;
  const sortedDeals=useMemo(()=>sortDeals(deals,sort.key,sort.direction,customFields),[deals,sort,customFields]);
  const orderedDefinitions=[...draft.map(key=>definitions.find(def=>def.key===key)).filter(Boolean),...definitions.filter(def=>!draft.includes(def.key))];
  const gridColumns=`34px ${visibleColumns.map(key=>key==='name'?'minmax(190px,1.6fr)':key==='amount'?'minmax(105px,.75fr)':'minmax(145px,1fr)').join(' ')}`;
  const ids=deals.map(deal=>deal.id);
  useEffect(()=>setSelected(current=>current.filter(id=>ids.includes(id))),[deals]);
  const chosen=deals.filter(deal=>selected.includes(deal.id));
  const toggle=id=>setSelected(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
  const chooseAction=async kind=>{
    if(kind==='stage'){
      const pipelines=new Set(chosen.map(deal=>deal.pipeline_id));
      if(pipelines.size!==1){onError(new Error('Для смены этапа выберите сделки одной воронки'));return}
      try{const stages=await api('/stages?pipeline_id='+[...pipelines][0]);setStageOptions(stages);setTarget(String(stages.find(stage=>stage.kind==='active')?.id||stages[0]?.id||''));setLossReason('')}catch(error){onError(error);return}
    }else if(kind==='field'){
      try{const fields=await api('/custom-fields?entity_type=deal');if(!fields.length){onError(new Error('Сначала создайте дополнительное поле сделки в настройках'));return}setFieldOptions(fields);setTarget(String(fields[0].id));setFieldValue('')}catch(error){onError(error);return}
    }else if(kind==='owner')setTarget(String(auth.role!=='admin'&&auth.deal_access==='own'?auth.id:users[0]?.id||''));
    else if(kind==='tags'){setTagMode('add');setTags('')}
    setAction(kind);
  };
  const apply=async()=>{
    setBusy(true);
    const payload=action==='owner'?{owner_id:Number(target)}:action==='stage'?{stage_id:Number(target),loss_reason:lossReason}:action==='task'?{title:taskTitle.trim(),due_at:due?new Date(due).toISOString():null,owner_id:auth.id}:action==='field'?{field_id:Number(target),value:fieldValue}:action==='tags'?{mode:tagMode,tags}:{};
    try{if(await onBulk(action,selected,payload)){setSelected([]);setAction('');setTaskTitle('');setDue('')}}finally{setBusy(false)}
  };
  const allowedUsers=auth.role!=='admin'&&auth.deal_access==='own'?[auth]:users;
  const activeField=fieldOptions.find(field=>field.id===Number(target));
  const cell=(deal,key)=>{
    if(key==='name')return <button className="deal-list-name" onClick={()=>onOpen(deal.id)}>{deal.name}</button>;
    if(key==='stage')return <span className="deal-list-stage"><i style={{background:deal.stage_color||'#bcd3f6'}}/>{deal.stage_name}</span>;
    if(key==='loss_reason')return <span>{deal.loss_reason||'—'}</span>;
    if(key==='amount')return <span>{money(deal.amount)}</span>;
    if(key==='created'||key==='updated')return <span>{date(deal[key+'_at'])}</span>;
    if(key.startsWith('field:')){let values={};try{values=JSON.parse(deal.custom_values||'{}')}catch{}return <span>{values[key.slice(6)]||'—'}</span>}
    const property={contact:'contact_name',company:'company_name',owner:'owner_name',pipeline:'pipeline_name'}[key]||key;
    return <span>{deal[property]||'—'}</span>;
  };
  const moveDraft=(key,offset)=>{const index=draft.indexOf(key),target=index+offset;if(index<0||target<0||target>=draft.length)return;setDraft(current=>{const next=[...current];[next[index],next[target]]=[next[target],next[index]];return next})};
  const saveColumns=async()=>{setBusy(true);try{const result=await api('/me/deal-columns',{method:'PUT',body:{columns:draft}});setColumns(result.columns);onCloseColumns()}catch(error){onError(error)}finally{setBusy(false)}};
  const toggleSort=key=>setSort(current=>current.key===key?{key,direction:current.direction==='asc'?'desc':'asc'}:{key,direction:key==='amount'||key==='created'||key==='updated'?'desc':'asc'});
  const bulkBar=selected.length>0&&<div className="deal-bulk-bar"><span>{selected.length} выбрано</span><button onClick={()=>chooseAction('owner')}>см. отв.</button><button onClick={()=>chooseAction('task')}>доб. задачу</button><button onClick={()=>chooseAction('stage')}>изм. этап</button><button onClick={()=>chooseAction('field')}>изм. поле</button><button onClick={()=>chooseAction('tags')}>ред. теги</button><button className="deal-bulk-danger" onClick={()=>chooseAction('delete')}>удалить</button><button className="deal-bulk-clear" onClick={()=>{setSelected([]);setAction('')}}>Сбросить</button></div>;
  return <div className="deal-list-page">
    {columnsOpen&&<div className="deal-columns-popover" role="dialog" aria-label="Колонки списка"><h2>КОЛОНКИ СПИСКА</h2><p>Выберите поля и порядок отображения</p><div className="deal-columns-options">{orderedDefinitions.map(def=><div className="deal-column-option" key={def.key}><label><input type="checkbox" checked={draft.includes(def.key)} disabled={def.key==='name'} onChange={event=>setDraft(current=>event.target.checked?[...current,def.key]:current.filter(key=>key!==def.key))}/><span>{def.label}</span></label>{draft.includes(def.key)&&<div><button aria-label={'Выше: '+def.label} disabled={draft.indexOf(def.key)===0} onClick={()=>moveDraft(def.key,-1)}>↑</button><button aria-label={'Ниже: '+def.label} disabled={draft.indexOf(def.key)===draft.length-1} onClick={()=>moveDraft(def.key,1)}>↓</button></div>}</div>)}</div><footer><button onClick={onCloseColumns}>Отмена</button><button className="blue-btn" disabled={busy} onClick={saveColumns}>{busy?'Сохраняем…':'Готово'}</button></footer></div>}
    {bulkBar}
    <div className="deal-list-table deal-list-desktop" style={{minWidth:Math.max(600,190+visibleColumns.length*155)}}>
      <div className="deal-list-head" style={{gridTemplateColumns:gridColumns}}><label><input type="checkbox" checked={ids.length>0&&selected.length===ids.length} onChange={event=>setSelected(event.target.checked?ids:[])}/></label>{visibleColumns.map(key=><button className={'deal-list-sort'+(sort.key===key?' selected':'')} key={key} onClick={()=>toggleSort(key)} aria-label={'Сортировать: '+definitions.find(def=>def.key===key)?.label+(sort.key===key?', сейчас '+(sort.direction==='asc'?'по возрастанию':'по убыванию'):'')} aria-pressed={sort.key===key}>{definitions.find(def=>def.key===key)?.label}<span aria-hidden="true">{sort.key===key?(sort.direction==='asc'?'↑':'↓'):'↕'}</span></button>)}</div>
      {sortedDeals.map(deal=><div className="deal-list-row" style={{gridTemplateColumns:gridColumns}} key={deal.id}><label><input type="checkbox" checked={selected.includes(deal.id)} onChange={()=>toggle(deal.id)} aria-label={'Выбрать сделку '+deal.name}/></label>{visibleColumns.map(key=><React.Fragment key={key}>{cell(deal,key)}</React.Fragment>)}</div>)}
      {!deals.length&&<div className="empty">Сделок пока нет</div>}
    </div>
    <div className="deal-mobile-list">
      <div className="deal-mobile-toolbar"><label><input type="checkbox" checked={ids.length>0&&selected.length===ids.length} onChange={event=>setSelected(event.target.checked?ids:[])}/> Выбрать все</label><select aria-label="Сортировка сделок" value={sort.key} onChange={event=>{const key=event.target.value;setSort({key,direction:key==='amount'||key==='created'||key==='updated'?'desc':'asc'})}}><option value="">Исходный порядок</option>{visibleColumns.map(key=><option value={key} key={key}>{definitions.find(def=>def.key===key)?.label}</option>)}</select><button aria-label="Изменить порядок сортировки" disabled={!sort.key} onClick={()=>setSort(current=>({...current,direction:current.direction==='asc'?'desc':'asc'}))}>{sort.direction==='asc'?'↑':'↓'}</button></div>
      {sortedDeals.map(deal=><article className="deal-mobile-card" key={deal.id}><div className="deal-mobile-card-head"><input type="checkbox" checked={selected.includes(deal.id)} onChange={()=>toggle(deal.id)} aria-label={'Выбрать сделку '+deal.name}/><button onClick={()=>onOpen(deal.id)}>{deal.name}</button><strong>{money(deal.amount)}</strong></div><div className="deal-mobile-stage"><i style={{background:deal.stage_color||'#bcd3f6'}}/>{deal.stage_name}{showPipeline&&<small>{deal.pipeline_name}</small>}</div><div className="deal-mobile-fields">{visibleColumns.filter(key=>!['name','stage','amount'].includes(key)&&!(showPipeline&&key==='pipeline')).map(key=><div key={key}><span>{definitions.find(def=>def.key===key)?.label}</span>{cell(deal,key)}</div>)}</div></article>)}
      {!deals.length&&<div className="empty">Сделок пока нет</div>}
    </div>
    <div className="deal-list-footer">{deals.length} сделок</div>
    {action&&<div className="deal-bulk-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setAction('')}}><section className="deal-bulk-dialog" role="dialog" aria-modal="true" aria-label="Массовое действие"><h2>{action==='owner'?'Сменить ответственного':action==='stage'?'Изменить этап':action==='task'?'Добавить задачу':action==='field'?'Изменить поле':action==='tags'?'Редактировать теги':'Удалить сделки?'}</h2><p>Выбрано сделок: {selected.length}</p>{action==='owner'&&<label>Ответственный<select value={target} onChange={event=>setTarget(event.target.value)}>{allowedUsers.map(user=><option value={user.id} key={user.id}>{user.name}</option>)}</select></label>}{action==='stage'&&<><label>Этап<select value={target} onChange={event=>{setTarget(event.target.value);setLossReason('')}}>{stageOptions.map(stage=><option value={stage.id} key={stage.id}>{stage.name}</option>)}</select></label>{stageOptions.find(stage=>stage.id===Number(target))?.kind==='lost'&&<label>Причина отказа<select value={lossReason} onChange={event=>setLossReason(event.target.value)}>{lossReasons.map(reason=><option key={reason} value={reason==='Без причины'?'':reason}>{reason}</option>)}</select></label>}</>}{action==='task'&&<><label>Что нужно сделать<input autoFocus required maxLength={500} value={taskTitle} onChange={event=>setTaskTitle(event.target.value)}/></label><label>Срок<input type="datetime-local" value={due} onChange={event=>setDue(event.target.value)}/></label></>}{action==='field'&&<><label>Поле<select value={target} onChange={event=>{setTarget(event.target.value);setFieldValue('')}}>{fieldOptions.map(field=><option value={field.id} key={field.id}>{field.name}</option>)}</select></label><label>Значение<CustomValueInput field={activeField} value={fieldValue} onChange={setFieldValue} autoFocus/></label></>}{action==='tags'&&<><label>Действие<select value={tagMode} onChange={event=>setTagMode(event.target.value)}><option value="add">Добавить</option><option value="remove">Убрать</option><option value="replace">Заменить все</option></select></label><label>Теги через запятую<input autoFocus maxLength={1000} value={tags} onChange={event=>setTags(event.target.value)} placeholder="Например: горячий, повторный"/></label></>}{action==='delete'&&<p>Сделки исчезнут из воронок и отчётов. Их можно восстановить в корзине.</p>}<div className="deal-bulk-actions"><button onClick={()=>setAction('')} disabled={busy}>Отмена</button><button className={action==='delete'?'danger':'blue-btn'} onClick={apply} disabled={busy||action==='task'&&!taskTitle.trim()||['owner','stage','field'].includes(action)&&!target||action==='tags'&&tagMode!=='replace'&&!tags.trim()}>{busy?'Сохраняем…':action==='delete'?'Удалить':'Применить'}</button></div></section></div>}
  </div>;
}
