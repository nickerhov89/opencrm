import React, {useEffect, useMemo, useState} from 'react';
import CustomValueInput from './CustomValueInput.jsx';
import {Building2, MoreHorizontal} from 'lucide-react';
import './entity-list.css';
import './deal-list.css';

const labels={contact:['контакт','контакта','контактов'],company:['компания','компании','компаний'],all:['запись','записи','записей']};
export const entityNoun=(kind,count)=>labels[kind][count%10===1&&count%100!==11?0:count%10>=2&&count%10<=4&&(count%100<12||count%100>14)?1:2];

const columnDefaults={contact:['name','company','owner','phone','email'],company:['name','owner','phone','email'],all:['name','company','owner','phone','email']};
const date=value=>value?new Date(value.replace(' ','T')).toLocaleDateString('ru-RU'):'—';

export default function EntityList({kind,search,filter={owner_id:'',tag:'',preset:'',created_from:'',created_to:''},columnsOpen=false,onCloseColumns=()=>{},customFields=[],onOpen,onEdit,api,onError,onCount,reloadToken,users=[],auth,onTasksCreated}){
  const [page,setPage]=useState(1),[size,setSize]=useState(50),[query,setQuery]=useState(search),[result,setResult]=useState({items:[],total:0,pages:1}),[loading,setLoading]=useState(false),[selected,setSelected]=useState([]),[fields,setFields]=useState([]),[fieldId,setFieldId]=useState(''),[fieldValue,setFieldValue]=useState(''),[fieldOpen,setFieldOpen]=useState(false),[busy,setBusy]=useState(false),[taskOpen,setTaskOpen]=useState(false),[deleteOpen,setDeleteOpen]=useState(false),[ownerOpen,setOwnerOpen]=useState(false),[tagsOpen,setTagsOpen]=useState(false),[bulkOwner,setBulkOwner]=useState(auth?.id||''),[tagMode,setTagMode]=useState('add'),[tagText,setTagText]=useState(''),[taskTitle,setTaskTitle]=useState(''),[taskDue,setTaskDue]=useState(''),[taskType,setTaskType]=useState('Связаться'),[taskOwner,setTaskOwner]=useState(auth?.id||''),[reload,setReload]=useState(0);
  const [columns,setColumns]=useState(columnDefaults[kind]),[draftColumns,setDraftColumns]=useState(columnDefaults[kind]);
  const definitions=useMemo(()=>[
    {key:'name',label:'НАИМЕНОВАНИЕ'},
    ...(kind!=='company'?[{key:'company',label:'КОМПАНИЯ'},{key:'position',label:'ДОЛЖНОСТЬ'}]:[]),
    {key:'owner',label:'ОТВЕТСТВЕННЫЙ'},
    {key:'phone',label:'ТЕЛЕФОН'},
    {key:'email',label:'EMAIL'},
    ...(kind!=='contact'?[{key:'website',label:'САЙТ'}]:[]),
    {key:'tags',label:'ТЕГИ'},
    {key:'created',label:'ДАТА СОЗДАНИЯ'},
    ...customFields.filter(field=>kind==='all'?['contact','company'].includes(field.entity_type):field.entity_type===kind).map(field=>({key:`field:${field.id}`,label:field.name.toUpperCase()+(kind==='all'?' ('+(field.entity_type==='contact'?'КОНТАКТ':'КОМПАНИЯ')+')':'' )}))
  ],[kind,customFields]);
  useEffect(()=>{let active=true;api('/me/entity-columns?kind='+kind).then(data=>{if(active)setColumns(data.columns)}).catch(error=>{if(active)onError(error)});return()=>{active=false}},[kind,auth?.id]);
  useEffect(()=>{if(columnsOpen)setDraftColumns(columns.filter(key=>definitions.some(def=>def.key===key)))},[columnsOpen,columns,definitions]);
  const visibleColumns=columns.filter(key=>definitions.some(def=>def.key===key));
  if(!visibleColumns.length)visibleColumns.push(...columnDefaults[kind]);
  const orderedDefinitions=[...draftColumns.map(key=>definitions.find(def=>def.key===key)).filter(Boolean),...definitions.filter(def=>!draftColumns.includes(def.key))];
  const gridColumns=`${kind==='all'?'':'34px '}${visibleColumns.map(key=>key==='name'?'minmax(220px,1.6fr)':'minmax(135px,1fr)').join(' ')} 32px`;
  const columnCell=(item,key)=>{
    if(key==='name')return <button className="entity-list-name" onClick={()=>onOpen(item)}>{item._kind==='company'&&<Building2 size={15}/>}<span>{item.name}{item.tags&&<small className="entity-list-tags">{item.tags}</small>}</span></button>;
    if(key==='created')return <span>{date(item.created_at)}</span>;
    if(key.startsWith('field:')){let values={};try{values=JSON.parse(item.custom_values||'{}')}catch{}return <span>{values[key.slice(6)]||'—'}</span>}
    return <span>{item[{company:'company_name',owner:'owner_name'}[key]||key]||'—'}</span>;
  };
  const moveDraftColumn=(key,offset)=>{const index=draftColumns.indexOf(key),target=index+offset;if(index<0||target<0||target>=draftColumns.length)return;setDraftColumns(current=>{const next=[...current];[next[index],next[target]]=[next[target],next[index]];return next})};
  const saveColumns=async()=>{setBusy(true);try{const data=await api('/me/entity-columns',{method:'PUT',body:{kind,columns:draftColumns}});setColumns(data.columns);onCloseColumns()}catch(error){onError(error)}finally{setBusy(false)}};
  useEffect(()=>{const timer=setTimeout(()=>setQuery(search),200);return()=>clearTimeout(timer)},[search]);
  useEffect(()=>{setPage(1);setSelected([]);setResult({items:[],total:0,pages:1})},[kind,query,size,filter.owner_id,filter.tag,filter.preset,filter.created_from,filter.created_to]);
  useEffect(()=>{
    let active=true;
    setLoading(true);
    api(`/entity-list?kind=${kind}&page=${page}&page_size=${size}&q=${encodeURIComponent(query)}&owner_id=${encodeURIComponent(filter.owner_id)}&tag=${encodeURIComponent(filter.tag)}&preset=${encodeURIComponent(filter.preset)}&created_from=${encodeURIComponent(filter.created_from)}&created_to=${encodeURIComponent(filter.created_to)}`)
      .then(data=>{if(active){setResult(data);onCount(data.total)}})
      .catch(error=>{if(active)onError(error)})
      .finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[kind,query,page,size,filter.owner_id,filter.tag,filter.preset,filter.created_from,filter.created_to,reloadToken,reload]);
  const selectPage=next=>{setPage(next);setSelected([])};
  const openField=async()=>{try{const options=await api('/custom-fields?entity_type='+kind);if(!options.length){onError(new Error('Сначала создайте дополнительное поле в настройках'));return}setFields(options);setFieldId(String(options[0].id));setFieldValue('');setFieldOpen(true)}catch(error){onError(error)}};
  const saveField=async()=>{setBusy(true);try{await api('/entities/bulk-field',{method:'POST',body:{kind,ids:selected,field_id:Number(fieldId),value:fieldValue}});setSelected([]);setFieldOpen(false);setReload(value=>value+1)}catch(error){onError(error)}finally{setBusy(false)}};
  const saveTask=async()=>{setBusy(true);try{await api('/entities/bulk-task',{method:'POST',body:{kind,ids:selected,title:taskTitle,task_type:taskType,due_at:taskDue?new Date(taskDue).toISOString():null,owner_id:Number(taskOwner)}});setSelected([]);setTaskOpen(false);setTaskTitle('');setReload(value=>value+1);onTasksCreated?.()}catch(error){onError(error)}finally{setBusy(false)}};
  const saveOwner=async()=>{setBusy(true);try{await api('/entities/bulk',{method:'POST',body:{kind,ids:selected,action:'owner',owner_id:Number(bulkOwner)}});setSelected([]);setOwnerOpen(false);setReload(value=>value+1);onTasksCreated?.()}catch(error){onError(error)}finally{setBusy(false)}};
  const saveTags=async()=>{setBusy(true);try{await api('/entities/bulk',{method:'POST',body:{kind,ids:selected,action:'tags',mode:tagMode,tags:tagText}});setSelected([]);setTagsOpen(false);setTagText('');setReload(value=>value+1);onTasksCreated?.()}catch(error){onError(error)}finally{setBusy(false)}};
  const deleteSelected=async()=>{setBusy(true);try{await api('/entities/bulk-delete',{method:'POST',body:{kind,ids:selected}});setSelected([]);setDeleteOpen(false);setReload(value=>value+1);onTasksCreated?.()}catch(error){onError(error)}finally{setBusy(false)}};
  const taskUsers=auth?.role!=='admin'&&auth?.task_access==='own'?[auth]:users;
  const activeField=fields.find(field=>field.id===Number(fieldId));
  const pages=[1,page-1,page,page+1,result.pages].filter((number,index,array)=>number>=1&&number<=result.pages&&array.indexOf(number)===index).sort((a,b)=>a-b);
  const start=result.total?(page-1)*size+1:0,end=Math.min(page*size,result.total);
  const bulkBar=selected.length>0&&<div className="entity-bulk-bar"><strong>{selected.length} выбрано</strong><button onClick={()=>{setBulkOwner(auth?.id||'');setOwnerOpen(true)}}>ответственный</button><button onClick={()=>{setTagMode('add');setTagText('');setTagsOpen(true)}}>теги</button><button onClick={openField}>изм. поле</button><button onClick={()=>{setTaskOwner(auth?.id||'');setTaskOpen(true)}}>доб. задачу</button><button onClick={()=>setDeleteOpen(true)}>удалить</button><button onClick={()=>setSelected([])}>Сбросить</button></div>;
  const toggleSelected=id=>setSelected(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
  return <div className="entity-list-page">
    {columnsOpen&&<div className="deal-columns-popover" role="dialog" aria-label="Колонки списка"><h2>КОЛОНКИ СПИСКА</h2><p>Выберите поля и порядок отображения</p><div className="deal-columns-options">{orderedDefinitions.map(def=><div className="deal-column-option" key={def.key}><label><input type="checkbox" checked={draftColumns.includes(def.key)} disabled={def.key==='name'} onChange={event=>setDraftColumns(current=>event.target.checked?[...current,def.key]:current.filter(key=>key!==def.key))}/><span>{def.label}</span></label>{draftColumns.includes(def.key)&&<div><button aria-label={'Выше: '+def.label} disabled={draftColumns.indexOf(def.key)===0} onClick={()=>moveDraftColumn(def.key,-1)}>↑</button><button aria-label={'Ниже: '+def.label} disabled={draftColumns.indexOf(def.key)===draftColumns.length-1} onClick={()=>moveDraftColumn(def.key,1)}>↓</button></div>}</div>)}</div><footer><button onClick={onCloseColumns}>Отмена</button><button className="blue-btn" disabled={busy} onClick={saveColumns}>{busy?'Сохраняем…':'Готово'}</button></footer></div>}
    {bulkBar}
    <div className="entity-list-table entity-list-desktop" style={{minWidth:Math.max(600,visibleColumns.length*155+70)}}>
      <div className="entity-list-head" style={{gridTemplateColumns:gridColumns}}>{kind!=='all'&&<label><input type="checkbox" checked={result.items.length>0&&selected.length===result.items.length} onChange={event=>setSelected(event.target.checked?result.items.map(item=>item.id):[])}/></label>}{visibleColumns.map(key=><span key={key}>{definitions.find(def=>def.key===key)?.label}</span>)}<span></span></div>
      {result.items.map(item=><div className="entity-list-row" style={{gridTemplateColumns:gridColumns}} key={item._kind+':'+item.id}>
        {kind!=='all'&&<label><input type="checkbox" checked={selected.includes(item.id)} onChange={()=>toggleSelected(item.id)} aria-label={'Выбрать '+item.name}/></label>}
        {visibleColumns.map(key=><React.Fragment key={key}>{columnCell(item,key)}</React.Fragment>)}
        <button className="row-edit" title="Редактировать" onClick={()=>onEdit(item)}><MoreHorizontal size={18}/></button>
      </div>)}
      {!loading&&!result.items.length&&<div className="empty">{query||Object.values(filter).some(Boolean)?'Ничего не найдено':'Записей пока нет'}</div>}
    </div>
    <div className="entity-mobile-list">
      {kind!=='all'&&result.items.length>0&&<label className="entity-mobile-select-all"><input type="checkbox" checked={selected.length===result.items.length} onChange={event=>setSelected(event.target.checked?result.items.map(item=>item.id):[])}/> Выбрать все на странице</label>}
      {result.items.map(item=><article className="entity-mobile-card" key={item._kind+':'+item.id}>
        <div className="entity-mobile-card-head">{kind!=='all'&&<input type="checkbox" checked={selected.includes(item.id)} onChange={()=>toggleSelected(item.id)} aria-label={'Выбрать '+item.name}/>}<div className="entity-mobile-title">{columnCell(item,'name')}</div><button className="entity-mobile-edit" aria-label={'Редактировать '+item.name} onClick={()=>onEdit(item)}><MoreHorizontal size={18}/></button></div>
        <div className="entity-mobile-card-fields">{visibleColumns.filter(key=>key!=='name').map(key=><div key={key}><span>{definitions.find(def=>def.key===key)?.label}</span>{columnCell(item,key)}</div>)}</div>
      </article>)}
      {!loading&&!result.items.length&&<div className="empty">{query||Object.values(filter).some(Boolean)?'Ничего не найдено':'Записей пока нет'}</div>}
    </div>
    <div className="entity-list-footer"><span>{start}–{end} из {result.total} {entityNoun(kind,result.total)}</span><nav aria-label="Страницы списка"><button disabled={page===1} onClick={()=>selectPage(page-1)}>←</button>{pages.map((number,index)=><React.Fragment key={number}>{index>0&&number-pages[index-1]>1&&<span>…</span>}<button className={number===page?'active':''} onClick={()=>selectPage(number)}>{number}</button></React.Fragment>)}<button disabled={page>=result.pages} onClick={()=>selectPage(page+1)}>→</button></nav><label>Строк:<select value={size} onChange={event=>setSize(Number(event.target.value))}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label></div>
    {ownerOpen&&<div className="entity-field-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setOwnerOpen(false)}}><section className="entity-field-dialog" role="dialog" aria-modal="true" aria-label="Назначить ответственного"><h2>Назначить ответственного</h2><p>Выбрано {selected.length} {entityNoun(kind,selected.length)}</p><label>Ответственный<select autoFocus value={bulkOwner} onChange={event=>setBulkOwner(event.target.value)}>{users.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select></label><footer><button onClick={()=>setOwnerOpen(false)} disabled={busy}>Отмена</button><button className="blue-btn" disabled={busy||!bulkOwner} onClick={saveOwner}>{busy?'Сохраняем…':'Назначить'}</button></footer></section></div>}
    {tagsOpen&&<div className="entity-field-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setTagsOpen(false)}}><section className="entity-field-dialog" role="dialog" aria-modal="true" aria-label="Изменить теги"><h2>Изменить теги</h2><p>Выбрано {selected.length} {entityNoun(kind,selected.length)}</p><label>Действие<select value={tagMode} onChange={event=>setTagMode(event.target.value)}><option value="add">Добавить</option><option value="remove">Убрать</option><option value="replace">Заменить все</option></select></label><label>Теги через запятую<input autoFocus maxLength={1000} value={tagText} onChange={event=>setTagText(event.target.value)} placeholder={tagMode==='replace'?'Оставьте пустым, чтобы очистить':'Например: VIP, Пилот'}/></label><footer><button onClick={()=>setTagsOpen(false)} disabled={busy}>Отмена</button><button className="blue-btn" disabled={busy||(tagMode!=='replace'&&!tagText.trim())} onClick={saveTags}>{busy?'Сохраняем…':'Применить'}</button></footer></section></div>}
    {taskOpen&&<div className="entity-field-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setTaskOpen(false)}}><section className="entity-field-dialog" role="dialog" aria-modal="true" aria-label="Создать задачи"><h2>Создать задачи</h2><p>Для {selected.length} {entityNoun(kind,selected.length)}</p><label>Тип<select value={taskType} onChange={event=>setTaskType(event.target.value)}><option>Связаться</option><option>Встреча</option><option>Письмо</option><option>Другое</option></select></label><label>Что нужно сделать<input autoFocus required maxLength={500} value={taskTitle} onChange={event=>setTaskTitle(event.target.value)}/></label><label>Срок<input type="datetime-local" value={taskDue} onChange={event=>setTaskDue(event.target.value)}/></label><label>Ответственный<select value={taskOwner} onChange={event=>setTaskOwner(event.target.value)}>{taskUsers.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select></label><footer><button onClick={()=>setTaskOpen(false)} disabled={busy}>Отмена</button><button className="blue-btn" disabled={busy||!taskTitle.trim()} onClick={saveTask}>{busy?'Создаём…':'Создать задачи'}</button></footer></section></div>}
    {fieldOpen&&<div className="entity-field-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setFieldOpen(false)}}><section className="entity-field-dialog" role="dialog" aria-modal="true" aria-label="Изменить поле"><h2>Изменить поле</h2><p>Выбрано {selected.length} {entityNoun(kind,selected.length)}</p><label>Поле<select value={fieldId} onChange={event=>{setFieldId(event.target.value);setFieldValue('')}}>{fields.map(field=><option key={field.id} value={field.id}>{field.name}</option>)}</select></label><label>Значение<CustomValueInput field={activeField} value={fieldValue} onChange={setFieldValue} autoFocus/></label><footer><button onClick={()=>setFieldOpen(false)} disabled={busy}>Отмена</button><button className="blue-btn" disabled={busy||!fieldId} onClick={saveField}>{busy?'Сохраняем…':'Применить'}</button></footer></section></div>}
    {deleteOpen&&<div className="entity-field-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setDeleteOpen(false)}}><section className="entity-field-dialog" role="alertdialog" aria-modal="true" aria-label="Удалить записи"><h2>Удалить {selected.length} {entityNoun(kind,selected.length)}?</h2><p>Записи исчезнут из рабочих списков. Их можно вернуть в настройках из корзины вместе с историей и файлами.</p><footer><button onClick={()=>setDeleteOpen(false)} disabled={busy}>Отмена</button><button className="blue-btn" disabled={busy} onClick={deleteSelected}>{busy?'Удаляем…':'Переместить в корзину'}</button></footer></section></div>}
  </div>;
}
