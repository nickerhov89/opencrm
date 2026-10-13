import React from 'react';
import {defaultDealCardFields} from './deal-card-layout.js';
import './deal-card.css';

const parseStamp=value=>value?new Date(String(value).includes('T')?value:String(value).replace(' ','T')+'Z'):null;
const sameDay=(left,right)=>left.getFullYear()===right.getFullYear()&&left.getMonth()===right.getMonth()&&left.getDate()===right.getDate();
const shortDate=date=>date.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'});
const time=date=>date.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
const money=amount=>new Intl.NumberFormat('ru-RU').format(Number(amount)||0)+' ₽';
const taskNoun=count=>count%10===1&&count%100!==11?'открытая задача':count%10>=2&&count%10<=4&&(count%100<12||count%100>14)?'открытые задачи':'открытых задач';

function updatedLabel(value){
  const date=parseStamp(value),today=new Date();if(!date||!Number.isFinite(date.getTime()))return '';
  const yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);
  return sameDay(date,today)?`Сегодня ${time(date)}`:sameDay(date,yesterday)?`Вчера ${time(date)}`:shortDate(date);
}

function taskStatus(deal){
  if(!deal.open_tasks_count)return null;
  if(deal.overdue_tasks_count)return {label:'Просрочено',kind:'overdue'};
  const due=parseStamp(deal.next_task_at);if(!due||!Number.isFinite(due.getTime()))return {label:'Без срока',kind:'undated'};
  const today=new Date(),tomorrow=new Date(today);tomorrow.setDate(tomorrow.getDate()+1);
  return {label:sameDay(due,today)?'Сегодня':sameDay(due,tomorrow)?'Завтра':shortDate(due),kind:'upcoming'};
}

export default function DealCard({deal,onOpen,onDragStart,onDragEnd,dragging=false,fields=defaultDealCardFields,showAvatar=true,customFields=[]}){
  const status=taskStatus(deal),tags=String(deal.tags||'').split(',').map(tag=>tag.trim()).filter(Boolean);
  let customValues={};try{customValues=JSON.parse(deal.custom_values||'{}')||{}}catch{}
  const person=deal.contact_name||deal.company_name||'Сделка #'+deal.id;
  const caption=deal.contact_name&&deal.company_name&&deal.company_name!==deal.contact_name?`${person}, ${deal.company_name}`:person;
  const renderField=key=>{
    if(key==='client')return <span className="card-client" title={caption}>{showAvatar&&<i className="card-client-avatar" aria-hidden="true">{person.trim().slice(0,1).toLocaleUpperCase('ru-RU')}</i>}<span className="card-client-label">{caption}</span>{deal.contact_count>1&&<em>+{deal.contact_count-1}</em>}</span>;
    if(key==='updated')return <small className="card-updated">{updatedLabel(deal.updated_at)}</small>;
    if(key==='owner')return <span className="card-owner-name">{deal.owner_name||'Без ответственного'}</span>;
    if(key==='amount')return <b className="card-amount">{money(deal.amount)}</b>;
    if(key==='source')return <span className="card-source">{deal.source||'Без источника'}</span>;
    if(key==='tags')return <span className="card-tags">{tags.slice(0,2).map(tag=><span className="card-tag" key={tag}>{tag}</span>)}{tags.length>2&&<span className="card-extra-tags">+{tags.length-2}</span>}{!tags.length&&'Без тегов'}</span>;
    if(key==='task')return status?<span className={'card-task-status '+status.kind} title={`${deal.open_tasks_count} ${taskNoun(deal.open_tasks_count)}${deal.overdue_tasks_count?`, просрочено: ${deal.overdue_tasks_count}`:''}`}><i/>{status.label}</span>:<span className="card-no-task">Нет задач</span>;
    if(key==='last_communication')return deal.last_communication_text?<span className="card-last-communication" title={deal.last_communication_text}><small>{({call:'Звонок',email:'Письмо',message:'Сообщение'})[deal.last_communication_kind]||'Контакт'}:</small> {deal.last_communication_text}</span>:null;
    if(key.startsWith('field:')){const id=Number(key.slice(6)),field=customFields.find(item=>item.id===id&&item.entity_type==='deal');if(!field)return null;const raw=customValues[id]||'',display=field.field_type==='date'&&/^\d{4}-\d{2}-\d{2}$/.test(raw)?new Date(raw+'T00:00:00').toLocaleDateString('ru-RU'):raw||'—';return <span className="card-custom-field" title={`${field.name}: ${display}`}><small>{field.name}:</small> {display}</span>}
    return null;
  };
  const rows=[];for(let i=0;i<fields.length;i+=2)rows.push(fields.slice(i,i+2));
  return <article role="button" tabIndex={0} aria-label={`Открыть сделку ${deal.name}`} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',String(deal.id));onDragStart?.(deal.id)}} onDragEnd={()=>onDragEnd?.()} className={'deal-card'+(dragging?' is-dragging':'')} onClick={()=>onOpen(deal.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onOpen(deal.id)}}}>
    {rows.slice(0,1).map((row,index)=><div className="card-data-row" key={row.join(':')+index}>{row.map(key=><React.Fragment key={key}>{renderField(key)}</React.Fragment>)}</div>)}
    <div className="card-title">{deal.name}</div>
    {rows.slice(1).map((row,index)=><div className="card-data-row" key={row.join(':')+index}>{row.map(key=><React.Fragment key={key}>{renderField(key)}</React.Fragment>)}</div>)}
  </article>;
}
