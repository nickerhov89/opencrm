import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {taskTime} from './task-time.js';
import './task-calendar.css';

const dayStart = date => new Date(date.getFullYear(),date.getMonth(),date.getDate());
const addDays = (date,n) => new Date(date.getFullYear(),date.getMonth(),date.getDate()+n);
const monday = date => addDays(date,-(date.getDay()+6)%7);
const key = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const parse = value => value ? new Date(String(value).replace(' ','T')) : null;
const today = () => dayStart(new Date());
const format = (date,options) => date.toLocaleDateString('ru-RU',options);
const label = task => `${task.deal_name||task.contact_name||task.company_name||task.task_type||'Задача'}: ${task.title}`;
const taskNoun = count => count%10===1&&count%100!==11?'задача':count%10>=2&&count%10<=4&&(count%100<12||count%100>14)?'задачи':'задач';

function Event({task,onInspect,timed=false,style}) {
  const late=!task.completed_at&&parse(task.due_at)<new Date();
  return <button className={`amo-calendar-event${late?' late':''}${task.completed_at?' done':''}${timed?' timed':''}`} style={style} onClick={()=>onInspect(task)} title={`${taskTime(task)} · ${label(task)}`}><span>{!task.all_day&&taskTime(task)} {label(task)}</span></button>;
}

export default function TaskCalendar({tasks,mode,onModeChange,onInspect}) {
  const [cursor,setCursor]=useState(today);
  const [expandedAllDay,setExpandedAllDay]=useState('');
  const scrollRef=useRef(null);
  const monthRef=useRef(null);
  useEffect(()=>{if(mode==='month'&&monthRef.current)monthRef.current.scrollTop=0;else if(scrollRef.current)scrollRef.current.scrollTop=8*48},[mode]);
  const first=mode==='month'?new Date(cursor.getFullYear(),cursor.getMonth(),1):mode==='week'?monday(cursor):dayStart(cursor);
  const dates=useMemo(()=>{
    if(mode==='day')return [first];
    if(mode==='week')return Array.from({length:7},(_,i)=>addDays(first,i));
    const start=monday(first),end=new Date(first.getFullYear(),first.getMonth()+1,0);
    const count=Math.ceil((Math.round((end-start)/864e5)+1)/7)*7;
    return Array.from({length:count},(_,i)=>addDays(start,i));
  },[mode,first.getTime()]);
  const grouped=useMemo(()=>{
    const result=new Map();
    for(const task of tasks){const date=parse(task.due_at);if(!date||!Number.isFinite(date.getTime()))continue;const id=key(date);if(!result.has(id))result.set(id,[]);result.get(id).push({task,date});}
    for(const entries of result.values())entries.sort((a,b)=>Number(b.task.all_day)-Number(a.task.all_day)||a.date-b.date);
    return result;
  },[tasks]);
  const entries=date=>grouped.get(key(date))||[];
  const shift=n=>setCursor(current=>mode==='month'?new Date(current.getFullYear(),current.getMonth()+n,1):addDays(current,n*(mode==='week'?7:1)));
  const title=mode==='month'?format(cursor,{month:'long',year:'numeric'}):mode==='week'?`${format(first,{day:'numeric',month:'long'})} — ${format(addDays(first,6),{day:'numeric',month:'long',year:'numeric'})}`:format(cursor,{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const isToday=date=>key(date)===key(today());
  const cardLimit=mode==='day'?4:2;
  const showDay=date=>{setCursor(dayStart(date));setExpandedAllDay('');onModeChange('day')};

  return <div className="amo-calendar">
    <div className="amo-calendar-nav"><button aria-label="Предыдущий период" onClick={()=>shift(-1)}><ChevronLeft size={19}/></button><h2>{title}</h2><button aria-label="Следующий период" onClick={()=>shift(1)}><ChevronRight size={19}/></button></div>
    {mode==='month'?<div className="amo-calendar-month-scroll" ref={monthRef}><div className="amo-calendar-weekdays"><span/>{Array.from({length:7},(_,i)=><span key={i}>{format(addDays(monday(today()),i),{weekday:'short'})}</span>)}</div><div className="amo-calendar-month">{dates.map(date=>{const dayEntries=entries(date);return <div key={key(date)} className={`amo-calendar-month-cell${date.getMonth()!==cursor.getMonth()?' outside':''}${isToday(date)?' current':''}`}><button className="amo-calendar-day-number" onClick={()=>showDay(date)} aria-label={`Открыть ${format(date,{day:'numeric',month:'long',year:'numeric'})}`}>{date.getDate()}</button>{dayEntries.slice(0,cardLimit).map(({task})=><Event key={task.id} task={task} onInspect={onInspect}/>)}{dayEntries.length>cardLimit&&<button className="amo-calendar-more" onClick={()=>showDay(date)}>+{dayEntries.length-cardLimit} {taskNoun(dayEntries.length-cardLimit)}</button>}</div>})}</div></div>:
      <div className="amo-calendar-schedule-scroll" ref={scrollRef}><div className="amo-calendar-schedule" style={{'--calendar-days':dates.length}}><div className="amo-calendar-head"><div className="amo-calendar-gutter"/>{dates.map(date=><div className={`amo-calendar-head-day${isToday(date)?' current':''}`} key={key(date)}>{mode==='week'?format(date,{weekday:'short',day:'numeric',month:'short'}):'Весь день'}</div>)}</div><div className="amo-calendar-all-day"><div className="amo-calendar-gutter">{mode==='week'?'Весь день':''}</div>{dates.map(date=>{const allDay=entries(date).filter(({task})=>task.all_day);return <div className={`amo-calendar-all-day-cell${isToday(date)?' current':''}`} key={key(date)}>{allDay.slice(0,expandedAllDay===key(date)?undefined:3).map(({task})=><Event key={task.id} task={task} onInspect={onInspect}/>)}{allDay.length>3&&<button className="amo-calendar-more" onClick={()=>setExpandedAllDay(current=>current===key(date)?'':key(date))}>{expandedAllDay===key(date)?'Свернуть':`+${allDay.length-3} ${taskNoun(allDay.length-3)}`}</button>}</div>})}</div><div className="amo-calendar-hours"><div className="amo-calendar-time-axis">{Array.from({length:24},(_,hour)=><span key={hour} style={{top:hour*48}}>{String(hour).padStart(2,'0')}:00</span>)}</div>{dates.map(date=>{const timed=entries(date).filter(({task})=>!task.all_day);return <div className={`amo-calendar-hours-day${isToday(date)?' current':''}`} key={key(date)}>{timed.map(({task,date:at},index)=>{const start=at.getHours()*48+at.getMinutes()*.8;const duration=Math.max(25,Math.min(1440-at.getHours()*60-at.getMinutes(),Number(task.duration_minutes)||30)*.8);const same=timed.filter(item=>item.date.getTime()===at.getTime());const position=same.findIndex(item=>item.task.id===task.id);return <Event key={task.id} task={task} onInspect={onInspect} timed style={{top:start,height:duration,left:`calc(${position*100/same.length}% + 2px)`,width:`calc(${100/same.length}% - 4px)`,zIndex:index+1}}/>})}</div>})}</div></div></div>}
    <button className="amo-calendar-today" onClick={()=>setCursor(today())}>Сегодня</button>
  </div>;
}
