import React, {useState} from 'react';
import {Mail, MailOpen, Paperclip, Reply, ReplyAll, Send, X} from 'lucide-react';
import './deal-email.css';

const parseStamp=s=>s?new Date(s.includes('T')?s:s.replace(' ','T')+'Z'):null;
const dt=s=>s?parseStamp(s).toLocaleString('ru-RU',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}):'';
const person=item=>item?.name?`${item.name} <${item.address}>`:item?.address||'';
const size=bytes=>bytes>=1048576?`${(bytes/1048576).toFixed(1)} МБ`:bytes>=1024?`${Math.round(bytes/1024)} КБ`:`${bytes} Б`;
const splitList=text=>text.split(/[,;\s]+/).map(item=>item.trim()).filter(Boolean);
const lower=value=>String(value||'').trim().toLowerCase();

// The same rule as the server: reply to Reply-To or From; to our own sent letter, to its recipients.
export function replyDefaults(item,all){
  const self=lower(item.mailbox),ours=lower(item.from?.address)===self;
  const to=ours?item.to.map(entry=>entry.address):[item.reply_to||item.from?.address];
  const cc=!all?[]:ours?item.cc.map(entry=>entry.address):[...item.to,...item.cc].map(entry=>entry.address);
  const unique=list=>[...new Set(list.map(lower))].filter(Boolean);
  const toList=unique(to).filter(address=>address!==self);
  return {to:toList,cc:unique(cc).filter(address=>address!==self&&!toList.includes(address))};
}

function ReplyForm({item,all,onSend,onCancel}){
  const defaults=replyDefaults(item,all);
  const [to,setTo]=useState(defaults.to.join(', ')),[cc,setCc]=useState(defaults.cc.join(', ')),[text,setText]=useState(''),[quote,setQuote]=useState(true),[busy,setBusy]=useState(false);
  const submit=async event=>{event.preventDefault();if(busy||!text.trim())return;setBusy(true);try{const ok=await onSend({text,to:splitList(to),cc:splitList(cc),reply_all:all,quote});if(ok)onCancel()}finally{setBusy(false)}};
  return <form className="deal-email-reply" onSubmit={submit}>
    <label><span>Кому</span><input value={to} onChange={event=>setTo(event.target.value)} required aria-label="Кому"/></label>
    <label><span>Копия</span><input value={cc} onChange={event=>setCc(event.target.value)} aria-label="Копия"/></label>
    <div className="deal-email-reply-subject">Тема: {/^\s*(re|ответ)\s*(\[\d+\])?\s*:/i.test(item.subject)?item.subject:`Re: ${item.subject}`} · с ящика {item.mailbox}</div>
    <textarea autoFocus rows={5} value={text} onChange={event=>setText(event.target.value)} placeholder="Текст ответа" aria-label="Текст ответа" required/>
    <div className="deal-email-reply-actions"><label><input type="checkbox" checked={quote} onChange={event=>setQuote(event.target.checked)}/> Цитировать письмо</label><button type="button" onClick={onCancel}><X size={14}/> Отмена</button><button className="blue-btn" disabled={busy||!text.trim()}><Send size={14}/> {busy?'Отправляем…':'Отправить'}</button></div>
  </form>;
}

export default function DealEmail({item,onLoadEmail,onReplyEmail,canReply}){
  const [expanded,setExpanded]=useState(false),[full,setFull]=useState(null),[reply,setReply]=useState(null),[loading,setLoading]=useState(false);
  const incoming=item.direction==='incoming',Icon=incoming?Mail:MailOpen;
  const text=full??item.text,long=item.text_truncated||text.length>700||text.split('\n').length>12;
  const toggle=async()=>{if(!expanded&&item.text_truncated&&full==null){setLoading(true);try{const letter=await onLoadEmail(item.id);if(letter)setFull(letter.text)}finally{setLoading(false)}}setExpanded(value=>!value)};
  return <div className={'timeline-item deal-email '+(incoming?'incoming':'outgoing')}>
    <span className="timeline-icon"><Icon size={16}/></span>
    <div className="deal-email-body">
      <small>{dt(item.sent_at)}{item.mailbox?` · ${item.mailbox}`:''}{item.author?` · ${item.author}`:''}{item.linked_by==='thread'?' · по ветке':''}</small>
      <strong>{incoming?'Входящее письмо':'Исходящее письмо'}{item.subject?` · ${item.subject}`:''}</strong>
      <div className="deal-email-people"><span>От: {person(item.from)}</span><span>Кому: {item.to.map(person).join(', ')||'—'}</span>{item.cc.length>0&&<span>Копия: {item.cc.map(person).join(', ')}</span>}</div>
      <p className={long&&!expanded?'collapsed':''}>{text||'(без текста)'}</p>
      {long&&<button type="button" className="deal-email-more" onClick={toggle} disabled={loading}>{loading?'Загружаем…':expanded?'Свернуть':'Показать полностью'}</button>}
      {item.attachments.length>0&&<div className="deal-email-files">{item.attachments.map((file,index)=><span key={index} title={file.content_type}><Paperclip size={12}/> {file.filename} · {size(file.size)}</span>)}</div>}
      {canReply&&item.mailbox&&!reply&&<div className="deal-email-actions"><button type="button" onClick={()=>setReply('one')}><Reply size={14}/> Ответить</button><button type="button" onClick={()=>setReply('all')}><ReplyAll size={14}/> Ответить всем</button></div>}
      {reply&&<ReplyForm item={item} all={reply==='all'} onSend={body=>onReplyEmail(item.id,body)} onCancel={()=>setReply(null)}/>}
    </div>
  </div>;
}
