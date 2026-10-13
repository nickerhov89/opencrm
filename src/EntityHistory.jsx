import React from 'react';
import {CheckCircle2, Clock3, FileText} from 'lucide-react';
import {taskSchedule} from './task-time.js';
import {entityHistoryItems} from './entity-history-filter.js';
import './entity-page.css';

const parseDate=value=>value?new Date(value.includes('T')?value:value.replace(' ','T')+'Z'):new Date(0);
const day=value=>parseDate(value).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'});
const time=value=>parseDate(value).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});

export default function EntityHistory({entity,kind,onTask,query='',type='all'}){
  const items=entityHistoryItems(entity,kind,query,type);
  if(!items.length)return <div className="deal-timeline-empty">{query.trim()||type!=='all'?'Ничего не найдено':'История пока пуста'}</div>;
  return <div className="entity-history"><div className="date-divider">История</div>{items.map((item,index)=><React.Fragment key={item.type+':'+item.id}>
    {(index===0||day(item.at)!==day(items[index-1].at))&&<div className="entity-history-day">{day(item.at)}</div>}
    {item.type==='event'?<div className="entity-history-event"><Clock3 size={14}/><span><small>{time(item.at)} · {item.author||'Система'}</small><p>{item.event}</p></span></div>:item.type==='note'?<div className="timeline-item entity-history-note"><span className="timeline-icon"><FileText size={16}/></span><div><small>{time(item.at)} · {item.author||'Система'}</small><p>{item.body}</p></div></div>:<button className={'entity-task '+(item.completed_at?'completed':'')} onClick={()=>onTask?.(item)}><CheckCircle2 size={17}/><span><small>{item.completed_at?'Задача выполнена':'Задача в работе'} · {time(item.at)}</small><b>{item.task_type||'Связаться'}: {item.title}</b>{item.completed_at&&item.completion_result&&<em>Результат: {item.completion_result}</em>}</span><small>{taskSchedule(item)}</small></button>}
  </React.Fragment>)}</div>;
}
