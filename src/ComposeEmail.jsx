import React, {useEffect, useState} from 'react';
import {Send, X} from 'lucide-react';
import {appPath} from './app-base.js';

// «Шаблон»: fills the subject and the text from a letter template (Settings → Почта → Шаблоны писем).
// Shown only when templates exist; a text already typed is replaced only after a confirmation.
export function TemplatePicker({subject,text,onPick}){
  const [templates,setTemplates]=useState([]);
  useEffect(()=>{let alive=true;fetch(appPath('/api/mail/templates')).then(response=>response.ok?response.json():[]).then(list=>{if(alive&&Array.isArray(list))setTemplates(list)}).catch(()=>{});return()=>{alive=false}},[]);
  if(!templates.length)return null;
  const pick=event=>{const item=templates.find(row=>String(row.id)===event.target.value);event.target.value='';if(!item)return;if((text.trim()&&item.body)||(subject.trim()&&item.subject&&subject.trim()!==item.subject)){if(!window.confirm(`Заменить тему и текст письма шаблоном «${item.name}»?`))return}onPick({subject:item.subject||subject,text:item.body||text})};
  return <label>Шаблон<select aria-label="Шаблон письма" defaultValue="" onChange={pick}><option value="">Выбрать шаблон…</option>{templates.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>;
}

export const splitAddresses=text=>String(text||'').split(/[,;\s]+/).map(item=>item.trim()).filter(Boolean);

// A new letter from a connected mailbox. With deal_id it lands in that deal's feed, otherwise the
// server links it by the recipients' addresses, like an incoming letter.
export default function ComposeEmail({api,mailboxes,initial={},onClose,onSent,onError}){
  const [mailboxId,setMailboxId]=useState(String(initial.mailbox_id||mailboxes[0]?.id||'')),[to,setTo]=useState((initial.to||[]).join(', ')),[cc,setCc]=useState(''),[subject,setSubject]=useState(initial.subject||''),[text,setText]=useState(''),[busy,setBusy]=useState(false);
  const submit=async event=>{
    event.preventDefault();if(busy)return;setBusy(true);
    try{const sent=await api('/mail/send',{method:'POST',body:{mailbox_id:Number(mailboxId),to:splitAddresses(to),cc:splitAddresses(cc),subject,text,...(initial.deal_id?{deal_id:initial.deal_id}:{})}});await onSent(sent)}
    catch(error){onError(error)}finally{setBusy(false)}
  };
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><div className="modal compose-email" role="dialog" aria-label="Новое письмо">
    <div className="modal-head"><h2>Новое письмо</h2><button onClick={onClose} aria-label="Закрыть"><X size={20}/></button></div>
    <form className="modal-form" onSubmit={submit}>
      {initial.deal_name&&<div className="compose-deal">Сделка: <b>{initial.deal_name}</b></div>}
      <label>С ящика<select value={mailboxId} onChange={event=>setMailboxId(event.target.value)} required>{mailboxes.map(box=><option key={box.id} value={box.id}>{box.name?`${box.name} <${box.email}>`:box.email}</option>)}</select></label>
      <label>Кому<input autoFocus={!to} value={to} onChange={event=>setTo(event.target.value)} placeholder="client@company.ru, через запятую" required/></label>
      <label>Копия<input value={cc} onChange={event=>setCc(event.target.value)} placeholder="необязательно"/></label>
      <TemplatePicker subject={subject} text={text} onPick={item=>{setSubject(item.subject);setText(item.text)}}/>
      <label>Тема<input value={subject} maxLength={998} onChange={event=>setSubject(event.target.value)} required/></label>
      <label>Текст<textarea autoFocus={!!to} rows={12} value={text} maxLength={50000} onChange={event=>setText(event.target.value)} required/></label>
      <div className="modal-actions"><button type="button" onClick={onClose}>Отмена</button><button className="blue-btn" disabled={busy||!text.trim()||!splitAddresses(to).length}><Send size={14}/> {busy?'ОТПРАВЛЯЕМ…':'ОТПРАВИТЬ'}</button></div>
    </form>
  </div></div>;
}
