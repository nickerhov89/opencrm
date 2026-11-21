import React,{useState} from 'react';
import {splitAddresses} from './ComposeEmail.jsx';
import './deal-composer.css';

const modes=[['note','Примечание'],['call','Звонок'],['email','Письмо'],['message','Сообщение']];
const placeholders={note:'Написать примечание…',call:'Что обсудили по телефону?',email:'Содержание письма…',message:'Содержание переписки…'};

// «Письмо» sends a real letter when a mailbox is connected (mail.mailboxes) and the user may send;
// «Записать без отправки» keeps the old manual record for letters written elsewhere.
export default function DealComposer({note,setNote,onAddNote,onAddCommunication,onSendEmail,mail,recipients=[],onError}){
  const mailboxes=mail?.can_send?mail.mailboxes||[]:[];
  const [mode,setMode]=useState('note'),[direction,setDirection]=useState('outgoing'),[subject,setSubject]=useState(''),[body,setBody]=useState(''),[busy,setBusy]=useState(false);
  const [mailboxId,setMailboxId]=useState(''),[to,setTo]=useState(recipients.join(', ')),[cc,setCc]=useState(''),[recordOnly,setRecordOnly]=useState(false);
  const sending=mode==='email'&&mailboxes.length>0&&!recordOnly;
  const content=mode==='note'?note:body;
  const ready=!!content.trim()&&(!sending||splitAddresses(to).length>0&&!!subject.trim());
  const submit=async event=>{
    event.preventDefault();
    if(busy||!ready)return;
    setBusy(true);
    try{
      if(mode==='note')await onAddNote();
      else if(sending){if(await onSendEmail({mailbox_id:Number(mailboxId||mailboxes[0].id),to:splitAddresses(to),cc:splitAddresses(cc),subject:subject.trim(),text:body.trim()})){setBody('');setSubject('');setCc('')}}
      else{await onAddCommunication({kind:mode,direction,subject:mode==='email'?subject.trim():'',body:body.trim()});setBody('');setSubject('')}
    }catch(error){onError(error)}finally{setBusy(false)}
  };
  return <form className="note-compose deal-compose" onSubmit={submit}>
    <div className="deal-compose-modes" role="tablist" aria-label="Тип записи">
      {modes.map(([key,label])=><button type="button" role="tab" aria-selected={mode===key} className={mode===key?'active':''} key={key} onClick={()=>setMode(key)}>{label}</button>)}
    </div>
    {sending&&<div className="deal-compose-mail">
      <label>С ящика<select aria-label="Ящик отправителя" value={mailboxId||String(mailboxes[0].id)} onChange={event=>setMailboxId(event.target.value)}>{mailboxes.map(box=><option key={box.id} value={box.id}>{box.email}</option>)}</select></label>
      <label>Кому<input aria-label="Кому" value={to} onChange={event=>setTo(event.target.value)} placeholder="адрес клиента"/></label>
      <label>Копия<input aria-label="Копия" value={cc} onChange={event=>setCc(event.target.value)} placeholder="необязательно"/></label>
      <label>Тема<input aria-label="Тема письма" maxLength={998} value={subject} onChange={event=>setSubject(event.target.value)}/></label>
    </div>}
    {mode!=='note'&&!sending&&<div className="deal-compose-meta"><label>Направление<select aria-label="Направление коммуникации" value={direction} onChange={event=>setDirection(event.target.value)}><option value="outgoing">Исходящее</option><option value="incoming">Входящее</option></select></label>{mode==='email'&&<label className="deal-compose-subject">Тема<input aria-label="Тема письма" maxLength={255} value={subject} onChange={event=>setSubject(event.target.value)}/></label>}</div>}
    <div className="deal-compose-entry"><textarea aria-label={mode==='note'?'Написать примечание':sending?'Текст письма':'Содержание коммуникации'} placeholder={placeholders[mode]} maxLength={sending?50000:10000} value={content} onChange={event=>mode==='note'?setNote(event.target.value):setBody(event.target.value)}/><button className="blue-btn" disabled={busy||!ready}>{busy?(sending?'Отправляем…':'Сохраняем…'):mode==='note'?'Добавить':sending?'Отправить':'Записать'}</button></div>
    {mode==='email'&&mailboxes.length>0&&<label className="deal-compose-record"><input type="checkbox" checked={recordOnly} onChange={event=>setRecordOnly(event.target.checked)}/> Записать без отправки (письмо уже отправлено из другой программы)</label>}
    {mode!=='note'&&!sending&&<small>{mode==='email'&&mailboxes.length===0?'Запись для истории сделки. Чтобы отправлять письма клиенту, администратор подключает ящик в «Настройки → Почта».':'Запись для истории сделки. Сообщение не отправляется клиенту.'}</small>}
  </form>;
}
