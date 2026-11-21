import React, {useEffect, useState} from 'react';
import {AlarmClock, Clock3, Inbox, Mail, X} from 'lucide-react';

const parseStamp=s=>s?new Date(s.includes('T')?s:s.replace(' ','T')+'Z'):null;
const when=s=>{const date=parseStamp(s);if(!date)return '';const now=new Date(),time=date.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});if(date.toDateString()===now.toDateString())return `Сегодня ${time}`;const yesterday=new Date(now.getTime()-864e5);if(date.toDateString()===yesterday.toDateString())return `Вчера ${time}`;return date.toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})};
const icons={task_overdue:AlarmClock,task_due:Clock3,email:Mail,lead:Inbox};
const filters=[['all','Все'],['task','Задачи'],['email','Почта'],['lead','Заявки']];

// The «Сообщения» panel: overdue and due tasks, unread letters, new requests. Opening it marks
// everything seen, so the badge on the menu button counts only what appeared after that.
export default function NotificationsPanel({api,onClose,onOpen,onSeen,onError}){
  const [data,setData]=useState(null),[filter,setFilter]=useState('all');
  useEffect(()=>{let live=true;api('/notifications').then(result=>{if(!live)return;setData(result);if(result.unseen)api('/notifications/seen',{method:'POST'}).then(onSeen).catch(()=>{})}).catch(onError);return()=>{live=false}},[]);
  useEffect(()=>{const key=event=>{if(event.key==='Escape')onClose()};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[]);
  const items=(data?.items||[]).filter(item=>filter==='all'||(filter==='task'?item.kind.startsWith('task'):item.kind===filter));
  return <><button className="lists-scrim" aria-label="Закрыть уведомления" onClick={onClose}></button>
    <div className="notify-flyout" role="dialog" aria-label="Уведомления">
      <div className="notify-head"><h2>УВЕДОМЛЕНИЯ</h2><button onClick={onClose} aria-label="Закрыть"><X size={18}/></button></div>
      <div className="notify-filters">{filters.map(([key,label])=><button key={key} className={filter===key?'selected':''} onClick={()=>setFilter(key)}>{label}</button>)}</div>
      <div className="notify-list">
        {!data&&<div className="empty">Загружаем…</div>}
        {data&&items.length===0&&<div className="empty">Новых уведомлений нет</div>}
        {items.map(item=>{const Icon=icons[item.kind]||Clock3;return <button key={item.id} className={'notify-item '+item.kind+(item.new?' new':'')} onClick={()=>onOpen(item)}>
          <span className="notify-icon"><Icon size={16}/></span>
          <span className="notify-text"><small>{item.title} · {when(item.at)}</small><b>{item.text}</b>{item.subtitle&&<em>{item.subtitle}</em>}</span>
        </button>})}
      </div>
    </div></>;
}
