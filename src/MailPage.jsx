import React, {useEffect, useRef, useState} from 'react';
import {ArrowLeft, CheckCheck, Mail, MailOpen, Menu, Paperclip, Plus, Reply, ReplyAll, Search, X} from 'lucide-react';
import ComposeEmail from './ComposeEmail.jsx';
import {ReplyForm} from './DealEmail.jsx';
import './mail-page.css';

const folders=[['inbox','Входящие'],['unread','Непрочитанные'],['sent','Отправленные'],['unlinked','Без сделки'],['all','Все письма']];
const parseStamp=s=>s?new Date(s.includes('T')?s:s.replace(' ','T')+'Z'):null;
const listDate=s=>{const date=parseStamp(s);if(!date)return '';const now=new Date();return date.toDateString()===now.toDateString()?date.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):date.toLocaleDateString('ru-RU',{day:'numeric',month:'short',...(date.getFullYear()!==now.getFullYear()?{year:'numeric'}:{})})};
const fullDate=s=>parseStamp(s)?.toLocaleString('ru-RU',{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})||'';
const person=item=>item?.name?`${item.name} <${item.address}>`:item?.address||'';
const short=item=>item?.name||item?.address||'';
const size=bytes=>bytes>=1048576?`${(bytes/1048576).toFixed(1)} МБ`:bytes>=1024?`${Math.round(bytes/1024)} КБ`:`${bytes} Б`;

function Letter({item,canSend,onReply,onDeal,onOpen,onUnread,onBack}){
  const [reply,setReply]=useState(null);
  const incoming=item.direction==='incoming';
  return <div className="mail-letter">
    <div className="mail-letter-head"><button className="mail-back" onClick={onBack} title="К списку писем"><ArrowLeft size={18}/></button><h2>{item.subject||'(без темы)'}</h2>{incoming&&<button className="outline-btn" onClick={onUnread}>НЕПРОЧИТАННОЕ</button>}</div>
    <div className="mail-letter-meta">
      <div><span>От</span><b>{person(item.from)}</b></div>
      <div><span>Кому</span><b>{item.to.map(person).join(', ')||'—'}</b></div>
      {item.cc.length>0&&<div><span>Копия</span><b>{item.cc.map(person).join(', ')}</b></div>}
      <div><span>Дата</span><b>{fullDate(item.sent_at)}{item.mailbox?` · ящик ${item.mailbox}`:''}{item.author?` · ${item.author}`:''}</b></div>
      <div><span>Сделка</span><b>{item.deal_id?<button className="mail-deal-link" onClick={()=>onDeal(item.deal_id)}>{item.deal_name||`Сделка №${item.deal_id}`}</button>:'не привязано'}</b></div>
    </div>
    <p className="mail-letter-text">{item.text||'(без текста)'}</p>
    {item.attachments.length>0&&<div className="deal-email-files">{item.attachments.map((file,index)=><span key={index} title={file.content_type}><Paperclip size={12}/> {file.filename} · {size(file.size)}</span>)}</div>}
    {canSend&&item.mailbox&&!reply&&<div className="deal-email-actions"><button type="button" onClick={()=>setReply('one')}><Reply size={14}/> Ответить</button><button type="button" onClick={()=>setReply('all')}><ReplyAll size={14}/> Ответить всем</button></div>}
    {reply&&<ReplyForm item={item} all={reply==='all'} onSend={body=>onReply(item.id,body)} onCancel={()=>setReply(null)}/>}
    {item.thread?.length>0&&<div className="mail-thread"><h3>Переписка · {item.thread.length+1}</h3>{item.thread.map(entry=><button key={entry.id} onClick={()=>onOpen(entry.id)} className={entry.direction}><span>{entry.direction==='incoming'?<Mail size={14}/>:<MailOpen size={14}/>} {short(entry.from)}</span><em>{entry.subject} — {entry.text.replace(/\s+/g,' ').slice(0,140)}</em><small>{listDate(entry.sent_at)}</small></button>)}</div>}
  </div>;
}

export default function MailPage({api,auth,summary,openRequest,onOpenDeal,onSettings,onChanged,onError,onMenu}){
  const [folder,setFolder]=useState('inbox'),[mailboxId,setMailboxId]=useState(''),[query,setQuery]=useState(''),[search,setSearch]=useState('');
  const [items,setItems]=useState([]),[more,setMore]=useState(false),[loading,setLoading]=useState(true),[open,setOpen]=useState(null),[compose,setCompose]=useState(false);
  const request=useRef(0);
  const load=async(offset=0)=>{
    const id=++request.current;setLoading(true);
    try{
      const params=new URLSearchParams({folder,limit:'50',offset:String(offset)});if(mailboxId)params.set('mailbox_id',mailboxId);if(search)params.set('q',search);
      const page=await api('/mail/emails?'+params);
      if(id!==request.current)return;
      setItems(current=>offset?[...current,...page.items]:page.items);setMore(page.more);
    }catch(error){onError(error)}finally{if(id===request.current)setLoading(false)}
  };
  useEffect(()=>{void load(0)},[folder,mailboxId,search]);
  useEffect(()=>{const timer=setTimeout(()=>setSearch(query.trim()),350);return()=>clearTimeout(timer)},[query]);
  const openLetter=async id=>{try{const letter=await api('/mail/emails/'+id);setOpen(letter);setItems(current=>current.map(item=>item.id===id?{...item,read:true}:item));onChanged()}catch(error){onError(error)}};
  useEffect(()=>{if(openRequest?.id)void openLetter(openRequest.id)},[openRequest]);
  const markUnread=async()=>{try{await api('/mail/emails/'+open.id+'/read',{method:'POST',body:{read:false}});setItems(current=>current.map(item=>item.id===open.id?{...item,read:false}:item));setOpen(null);onChanged()}catch(error){onError(error)}};
  const readAll=async()=>{try{await api('/mail/read-all',{method:'POST'});setItems(current=>current.map(item=>({...item,read:true})));onChanged();if(folder==='unread')void load(0)}catch(error){onError(error)}};
  const reply=async(id,body)=>{try{await api('/mail/emails/'+id+'/reply',{method:'POST',body});await openLetter(id);void load(0);return true}catch(error){onError(error);return false}};
  const mailboxes=summary?.mailboxes||[],senders=summary?.send_mailboxes||[],canSend=!!summary?.can_send&&senders.length>0;
  return <div className="mail-page">
    <header className="topbar mail-topbar">
      <button className="hamburger" onClick={onMenu}><Menu size={23}/></button>
      <div className="top-title">ПОЧТА</div>
      <select className="mail-folder" aria-label="Папка" value={folder} onChange={event=>{setFolder(event.target.value);setOpen(null)}}>{folders.map(([key,label])=><option key={key} value={key}>{label}{key==='unread'&&summary?.unread?` (${summary.unread})`:''}</option>)}</select>
      {mailboxes.length>1&&<select className="mail-folder" aria-label="Ящик" value={mailboxId} onChange={event=>{setMailboxId(event.target.value);setOpen(null)}}><option value="">Все ящики</option>{mailboxes.map(box=><option key={box.id} value={box.id}>{box.email}</option>)}</select>}
      <div className="top-search"><Search size={18}/><input aria-label="Поиск по почте" placeholder="Поиск по теме, адресу и тексту" value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button onClick={()=>setQuery('')}><X size={15}/></button>}</div>
      <div className="top-actions">
        {summary?.unread>0&&<button className="icon-btn" title="Отметить все прочитанными" aria-label="Отметить все прочитанными" onClick={readAll}><CheckCheck size={18}/></button>}
        {auth.role==='admin'&&<button className="outline-btn" onClick={onSettings}>НАСТРОЙКИ</button>}
        {canSend&&<button className="blue-btn" onClick={()=>setCompose(true)}><Plus size={16}/> НАПИСАТЬ</button>}
      </div>
    </header>
    {open?<Letter item={open} canSend={canSend&&senders.some(box=>box.id===open.mailbox_id)} onReply={reply} onDeal={onOpenDeal} onOpen={openLetter} onUnread={markUnread} onBack={()=>setOpen(null)}/>:
    <div className="mail-list">
      <div className="mail-row mail-head"><span>От кого</span><span>Сделка, тема и сообщение</span><span>Дата</span></div>
      {items.map(item=><div role="button" tabIndex={0} key={item.id} className={'mail-row'+(item.read?'':' unread')} onClick={()=>openLetter(item.id)} onKeyDown={event=>{if(event.key==='Enter')openLetter(item.id)}}>
        <span className="mail-from">{item.direction==='incoming'?<Mail size={14}/>:<MailOpen size={14}/>}<b>{item.direction==='incoming'?short(item.from):`Кому: ${item.to.map(short).join(', ')}`}</b></span>
        <span className="mail-summary">{item.deal_id?<button className="mail-deal" onClick={event=>{event.stopPropagation();onOpenDeal(item.deal_id)}} title="Открыть сделку">{item.deal_name||`№${item.deal_id}`}</button>:<i className="mail-deal none">без сделки</i>}<b>{item.subject||'(без темы)'}</b><em>{item.text.replace(/\s+/g,' ').slice(0,200)}</em>{item.attachments.length>0&&<Paperclip size={12}/>}</span>
        <span className="mail-date">{listDate(item.sent_at)}</span>
      </div>)}
      {!loading&&items.length===0&&<div className="empty">{mailboxes.length===0?<>Почтовые ящики не подключены.{auth.role==='admin'&&<><br/><button className="mail-link" onClick={onSettings}>Подключить в настройках</button></>}</>:search?'Ничего не найдено':'Писем нет'}</div>}
      {loading&&<div className="empty">Загружаем письма…</div>}
      {more&&!loading&&<button className="mail-more" onClick={()=>load(items.length)}>Показать ещё</button>}
    </div>}
    {compose&&<ComposeEmail api={api} mailboxes={senders} onClose={()=>setCompose(false)} onError={onError} onSent={async()=>{setCompose(false);onChanged();if(folder==='sent'||folder==='all')await load(0)}}/>}
  </div>;
}
