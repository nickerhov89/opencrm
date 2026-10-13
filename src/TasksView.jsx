import React, { useEffect, useMemo, useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import './task-result.css';
import './task-board.css';
import {taskBoardSchedule,taskSchedule} from './task-time.js';
import {matchTaskFilter} from './task-filter.js';
import TaskList from './TaskList.jsx';
import TaskCalendar from './TaskCalendar.jsx';

const dateOnly = date => new Date(date.getFullYear(),date.getMonth(),date.getDate());
const monday = date => { const d=dateOnly(date); d.setDate(d.getDate()-(d.getDay()+6)%7); return d; };
const plusDays = (date,n) => { const d=new Date(date); d.setDate(d.getDate()+n); return d; };
const parseDate = value => value ? new Date(value.replace(' ','T')) : null;

function classify(task) {
  const now=new Date(), today=dateOnly(now), tomorrow=plusDays(today,1), afterTomorrow=plusDays(today,2), nextWeek=plusDays(monday(now),7), afterNextWeek=plusDays(nextWeek,7), nextMonth=new Date(now.getFullYear(),now.getMonth()+1,1), due=parseDate(task.due_at);
  if(!due) return 'future';
  if(due<now&&!task.completed_at) return 'overdue';
  if(due<tomorrow) return 'today';
  if(due<afterTomorrow) return 'tomorrow';
  if(due<nextWeek) return 'week';
  if(due<afterNextWeek) return 'nextweek';
  if(due<nextMonth) return 'month';
  return 'future';
}

function TaskCard({task,onDeal,onEntity,onInspect}) {
  const contact=task.deal_contact_name||task.contact_name;
  const company=task.company_name&&task.company_name!==contact?task.company_name:null;
  return <article className="task-board-card" tabIndex={0} onClick={()=>onInspect(task)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();onInspect(task)}}}>
    <div className="task-card-first"><span className="task-person">{contact||company||task.deal_name||'Без контакта'}{contact&&company&&<span className="task-company">, {company}</span>}</span>{task.stage_name&&<span className="task-stage" style={{background:task.stage_color||'#dce7fb'}}>{task.stage_name}</span>}</div>
    {(task.deal_name||task.company_name||task.contact_name)&&<button className="task-deal" onClick={e=>{e.stopPropagation();if(task.deal_id)onDeal(task.deal_id);else if(task.company_id)onEntity('company',task.company_id);else if(task.contact_id)onEntity('contact',task.contact_id)}}>{task.deal_name||task.company_name||task.contact_name}</button>}
    <div className={'task-due '+(classify(task)==='overdue'?'late':classify(task)==='today'?'due-today':'')}>{taskBoardSchedule(task)} <span>для {task.owner_name||'ответственного'}</span></div>
    <div className="task-description"><span className="task-type">◔ <b>{task.task_type||'Связаться'}:</b></span> {task.title}</div>
    <button className="task-done" title={task.completed_at?'Посмотреть результат':'Завершить задачу'} onClick={e=>{e.stopPropagation();onInspect(task)}}><Check size={14}/></button>
  </article>;
}

const taskNoun=count=>count%10===1&&count%100!==11?'задача':count%10>=2&&count%10<=4&&(count%100<12||count%100>14)?'задачи':'задач';

function Group({title,items,accent,initialLimit=8,onDeal,onEntity,onInspect}) {
  const [limit,setLimit]=useState(initialLimit);
  useEffect(()=>setLimit(initialLimit),[items,initialLimit]);
  return <section className="task-group"><div className="task-group-head" style={{borderBottomColor:accent}}><h3>{title}</h3><span>{items.length} {taskNoun(items.length)}</span></div><div className="task-group-cards">{items.slice(0,limit).map(task=><TaskCard key={task.id} task={task} onDeal={onDeal} onEntity={onEntity} onInspect={onInspect}/>)}</div>{items.length>limit&&<button className="task-group-more" onClick={()=>setLimit(current=>current+initialLimit)}>Показать ещё</button>}</section>;
}

export function TaskResultDialog({task,onClose,onEdit,onDeal,onEntity,onComplete,onReopen,onDelete,canDelete}){
  const [result,setResult]=useState('');
  const [busy,setBusy]=useState(false);
  const submit=async event=>{event.preventDefault();if(!result.trim())return;setBusy(true);try{const saved=await onComplete(task,result.trim());if(saved)onClose()}finally{setBusy(false)}};
  const reopen=async()=>{setBusy(true);try{const saved=await onReopen(task);if(saved)onClose()}finally{setBusy(false)}};
  const remove=async()=>{setBusy(true);try{const saved=await onDelete(task);if(saved)onClose()}finally{setBusy(false)}};
  return <div className="task-result-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><section className="task-result-dialog" role="dialog" aria-modal="true" aria-label={task.completed_at?'Результат задачи':'Завершить задачу'}><div className="task-result-top"><button className="task-result-link" onClick={()=>{onClose();if(task.deal_id)onDeal(task.deal_id);else if(task.company_id)onEntity('company',task.company_id);else if(task.contact_id)onEntity('contact',task.contact_id)}} disabled={!task.deal_id&&!task.company_id&&!task.contact_id}>{task.deal_name||task.company_name||task.contact_name||'Задача без связи'}</button><span>{task.deal_contact_name||task.contact_name||task.company_name||''}</span></div><p className="task-result-summary"><time>{taskSchedule(task)}</time> для {task.owner_name||'ответственного'} <b>{task.task_type||'Связаться'} — {task.title}</b></p>{task.completed_at?<div className="task-result-completed"><strong>Результат</strong><p>{task.completion_result||'Результат не указан'}</p><button onClick={reopen} disabled={busy}>Вернуть в работу</button></div>:<form onSubmit={submit}><input autoFocus value={result} onChange={event=>setResult(event.target.value)} maxLength={5000} placeholder="Добавить результат" aria-label="Результат задачи"/><button disabled={busy||!result.trim()}>{busy?'Сохраняем…':'Выполнить'}</button></form>}<div className="task-result-foot">{canDelete&&<button className="task-result-delete" onClick={remove} disabled={busy}><Trash2 size={13}/> Удалить задачу</button>}<button onClick={()=>{onClose();onEdit(task)}}>Изменить задачу</button><button onClick={onClose}>Закрыть</button></div></section></div>;
}

export default function TasksView({tasks,search,state,setState,filter,currentUserId,mode,onModeChange,onDeal,onEntity,onEdit,onComplete,onReopen,onDelete,onBulk,users,canDelete,canEdit}) {
  const [selected,setSelected]=useState(null);
  const filtered=useMemo(()=>tasks.filter(t=>(state==='all'||(state==='done'?!!t.completed_at:!t.completed_at))&&matchTaskFilter(t,filter,currentUserId)&&[t.title,t.deal_name,t.contact_name,t.deal_contact_name,t.company_name,t.owner_name].join(' ').toLowerCase().includes(search.toLowerCase())),[tasks,search,state,filter,currentUserId]);
  const groups=useMemo(()=>Object.groupBy(filtered,classify),[filtered]);
  const props={onDeal,onEntity,onInspect:setSelected};
  let content;
  if(['day','week','month'].includes(mode)) content=<TaskCalendar tasks={filtered} mode={mode} onModeChange={onModeChange} onInspect={setSelected}/>;
  else if(mode==='list') content=<TaskList tasks={filtered} state={state} setState={setState} search={search} filter={filter} users={users} currentUserId={currentUserId} onInspect={setSelected} onDeal={onDeal} onEntity={onEntity} onBulk={onBulk} canDelete={canDelete} canEdit={canEdit}/>;
  else content=<div className="tasks-board"><div className="task-lane"><Group title="ПРОСРОЧЕННЫЕ ЗАДАЧИ" items={groups.overdue||[]} accent="#e78b8d" {...props}/></div><div className="task-lane"><Group title="ЗАДАЧИ НА СЕГОДНЯ" items={groups.today||[]} accent="#a0d1ba" {...props}/></div><div className="task-lane"><Group title="ЗАДАЧИ НА ЗАВТРА" items={groups.tomorrow||[]} accent="#c7c8cb" {...props}/></div><div className="task-lane task-lane-upcoming"><Group title="ЗАДАЧИ НА ЭТУ НЕДЕЛЮ" items={groups.week||[]} initialLimit={3} accent="#c7c8cb" {...props}/><Group title="ЗАДАЧИ НА СЛЕДУЮЩУЮ НЕДЕЛЮ" items={groups.nextweek||[]} initialLimit={3} accent="#c7c8cb" {...props}/><Group title="ЗАДАЧИ НА МЕСЯЦ" items={groups.month||[]} initialLimit={3} accent="#c7c8cb" {...props}/><Group title="ЗАДАЧИ НА БУДУЩЕЕ" items={groups.future||[]} initialLimit={3} accent="#c7c8cb" {...props}/></div></div>;
  return <>{content}{selected&&<TaskResultDialog task={selected} onClose={()=>setSelected(null)} onEdit={onEdit} onDeal={onDeal} onEntity={onEntity} onComplete={onComplete} onReopen={onReopen} onDelete={onDelete} canDelete={canDelete}/>}</>;
}
