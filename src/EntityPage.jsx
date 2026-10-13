import React, { useEffect, useState } from 'react';
import { ArrowLeft, Check, FileText, Mail, Phone, Plus, Search, UserRound, X } from 'lucide-react';
import CustomFields from './CustomFields.jsx';
import Attachments from './Attachments.jsx';
import InlineField from './InlineField.jsx';
import DetailResizer, {useDetailSplit} from './DetailResizer.jsx';
import EntityHistory from './EntityHistory.jsx';
import {TaskResultDialog} from './TasksView.jsx';
import {isUpcomingTask,taskBoardSchedule} from './task-time.js';
import './entity-page.css';
import './deal-timeline.css';

const formatDate=value=>value?new Date(value.replace(' ','T')).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}):'—';
const money=value=>new Intl.NumberFormat('ru-RU').format(Number(value)||0)+' ₽';

export default function EntityPage({entity,kind,companies,users,onBack,onEdit,onUpdate,onDelete,onDeal,onRelated,onSaveField,onUploaded,onError,onAddNote,onTask,onTaskEdit,onTaskComplete,onTaskReopen,onTaskDelete,canDeleteTask}) {
  const [note,setNote]=useState('');
  const [tab,setTab]=useState('Основное');
  const [confirmDelete,setConfirmDelete]=useState(false);
  const [deleting,setDeleting]=useState(false);
  const [titleEdit,setTitleEdit]=useState(false);
  const [name,setName]=useState(entity.name);
  const [selectedTask,setSelectedTask]=useState(null);
  const [historyQuery,setHistoryQuery]=useState('');
  const [historyType,setHistoryType]=useState('all');
  const [historyFilterOpen,setHistoryFilterOpen]=useState(false);
  const split=useDetailSplit();
  useEffect(()=>{setName(entity.name);setTitleEdit(false)},[entity.id,entity.name]);
  useEffect(()=>setTab('Основное'),[entity.id]);
  useEffect(()=>{setHistoryQuery('');setHistoryType('all');setHistoryFilterOpen(false)},[entity.id,kind]);
  const title=kind==='contact'?'Контакт':'Компания';
  const save=(field,value)=>onUpdate({[field]:value});
  const saveName=async()=>{if(!name.trim())return;const ok=await save('name',name.trim());if(ok!==false)setTitleEdit(false)};
  const upcomingTasks=(entity.tasks||[]).filter(task=>isUpcomingTask(task)).sort((a,b)=>new Date(a.due_at)-new Date(b.due_at));
  const historyFiltered=Boolean(historyQuery.trim()||historyType!=='all');
  return <div ref={split.layoutRef} className="detail-layout entity-detail resizable-detail" style={split.style}>
    <div className="detail-left"><div className="detail-hero"><div className="detail-heading"><button onClick={onBack} aria-label="Назад"><ArrowLeft size={18}/></button>{titleEdit?<div className="deal-title-edit"><input autoFocus aria-label="Название" value={name} onChange={event=>setName(event.target.value)} onKeyDown={event=>{if(event.key==='Escape')setTitleEdit(false);if(event.key==='Enter')saveName()}}/><button aria-label="Сохранить название" onClick={saveName}><Check size={16}/></button></div>:<h1 onClick={()=>setTitleEdit(true)} title="Изменить название">{entity.name}</h1>}</div><div className="detail-id">{title} · #{entity.id} <span className="entity-header-tags">{entity.tags||'#ТЕГИРОВАТЬ'}</span></div>{(entity.phone||entity.email)&&<div className="entity-quick-actions">{entity.phone&&<a href={`tel:${entity.phone.replace(/[^+\d]/g,'')}`}><Phone size={14}/> Позвонить</a>}{entity.email&&<a href={`mailto:${entity.email.replace(/[\r\n?#]/g,'')}`}><Mail size={14}/> Написать</a>}</div>}<div className="detail-tabs"><button className={tab==='Основное'?'active':''} onClick={()=>setTab('Основное')}>Основное</button><button className={tab==='Сделки'?'active':''} onClick={()=>setTab('Сделки')}>Сделки</button><button className={tab==='Файлы'?'active':''} onClick={()=>setTab('Файлы')}>Файлы</button><button onClick={onEdit}>Ещё поля</button><button onClick={()=>setConfirmDelete(true)}>Удалить</button></div></div>
      {tab==='Основное'&&<div className="detail-fields deal-inline-fields"><InlineField label="Отв-ный" value={entity.owner_id} display={entity.owner_name} options={users} type="select" onSave={value=>save('owner_id',value)}/><InlineField label={kind==='contact'?'Должность':'Сайт'} value={kind==='contact'?entity.position:entity.website} onSave={value=>save(kind==='contact'?'position':'website',value)}/>{kind==='company'&&<InlineField label="Адрес" value={entity.address} onSave={value=>save('address',value)}/>}<InlineField label="Телефон" value={entity.phone} onSave={value=>save('phone',value)}/><InlineField label="Email" value={entity.email} onSave={value=>save('email',value)}/>{kind==='contact'&&<InlineField label="Компания" value={entity.company_id} display={entity.company_name} options={companies} type="select" onSave={value=>save('company_id',value)} onOpen={entity.company_id?()=>onRelated('company',entity.company_id):undefined}/>}<InlineField label="Теги" value={entity.tags} onSave={value=>save('tags',value)}/><InlineField label="Примечание" value={entity.notes} type="textarea" onSave={value=>save('notes',value)}/><div className="field-row"><span>Создан</span><b>{formatDate(entity.created_at)}</b></div><CustomFields fields={entity.custom_fields} onSave={onSaveField}/><button className="edit-fields" onClick={onEdit}>Все поля</button></div>}
      {tab==='Сделки'&&<div className="entity-deals-tab"><h2>Сделки · {entity.deals?.length||0}</h2>{entity.deals?.map(deal=><button className="entity-deal" key={deal.id} onClick={()=>onDeal(deal.id)}><FileText size={18}/><span><b>{deal.name}</b><small>{deal.stage_name} · {deal.owner_name||'—'}</small></span><strong>{money(deal.amount)}</strong></button>)}{!entity.deals?.length&&<p>Сделок пока нет</p>}</div>}
      {tab==='Файлы'&&<Attachments entityType={kind} entityId={entity.id} items={entity.attachments} onUploaded={onUploaded} onError={onError}/>}
      {tab==='Основное'&&kind==='company'&&<section className="entity-related"><h2>Контакты · {entity.contacts?.length||0}</h2>{entity.contacts?.map(contact=><button key={contact.id} onClick={()=>onRelated('contact',contact.id)}><UserRound size={15}/>{contact.name}</button>)}</section>}
    </div>
    <DetailResizer split={split}/>
    <div className="detail-timeline"><div className="timeline-head"><div className="deal-timeline-search"><Search size={17}/><input aria-label="Поиск по истории" placeholder="Поиск и фильтр" value={historyQuery} onChange={event=>setHistoryQuery(event.target.value)}/>{historyQuery&&<button aria-label="Очистить поиск" onClick={()=>setHistoryQuery('')}><X size={14}/></button>}<button className={historyType!=='all'?'selected':''} aria-label="Фильтр истории" aria-expanded={historyFilterOpen} onClick={()=>setHistoryFilterOpen(value=>!value)}>Фильтр</button>{historyFilterOpen&&<div className="deal-timeline-filter">{[['all','Все события'],['note','Примечания'],['task','Задачи'],['event','Изменения']].map(([value,label])=><button key={value} className={historyType===value?'selected':''} onClick={()=>{setHistoryType(value);setHistoryFilterOpen(false)}}>{label}</button>)}</div>}</div><button className="entity-add-task" onClick={onTask}><Plus size={14}/> Задача</button></div><div className="timeline-scroll"><EntityHistory entity={entity} kind={kind} onTask={setSelectedTask} query={historyQuery} type={historyType}/></div>{!historyFiltered&&upcomingTasks.length>0&&<div className="deal-upcoming-tasks" aria-label="Предстоящие задачи">{upcomingTasks.map(task=><button key={task.id} onClick={()=>setSelectedTask(task)}><span className="deal-upcoming-circle">◯</span><span>{taskBoardSchedule(task)} для {task.owner_name||"ответственного"}</span>{task.deal_name&&<em className="entity-upcoming-deal">{task.deal_name}</em>}<strong>{task.task_type||"Связаться"}</strong><span>— {task.title}</span></button>)}</div>}<form className="note-compose" onSubmit={async event=>{event.preventDefault();if(!note.trim())return;const saved=await onAddNote(note);if(saved)setNote('')}}><textarea placeholder="Добавить заметку…" value={note} onChange={event=>setNote(event.target.value)}/><button className="blue-btn" disabled={!note.trim()}><Plus size={14}/> Добавить</button></form></div>
    {selectedTask&&<TaskResultDialog task={{...selectedTask,contact_name:kind==='contact'?entity.name:selectedTask.contact_name,company_name:kind==='company'?entity.name:entity.company_name}} onClose={()=>setSelectedTask(null)} onEdit={onTaskEdit} onDeal={onDeal} onEntity={onRelated} onComplete={onTaskComplete} onReopen={onTaskReopen} onDelete={onTaskDelete} canDelete={canDeleteTask}/>}
    {confirmDelete&&<div className="entity-field-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setConfirmDelete(false)}}><section className="entity-field-dialog" role="alertdialog" aria-modal="true" aria-label={'Удалить '+title.toLowerCase()}><h2>Удалить {title.toLowerCase()}?</h2><p>«{entity.name}» исчезнет из рабочих списков. Запись и её историю можно вернуть через корзину в настройках.</p><footer><button disabled={deleting} onClick={()=>setConfirmDelete(false)}>Отмена</button><button className="blue-btn" disabled={deleting} onClick={async()=>{setDeleting(true);try{await onDelete()}catch(error){onError(error);setDeleting(false)}}}>{deleting?'Удаляем…':'Переместить в корзину'}</button></footer></section></div>}
  </div>;
}
