import React,{useState} from 'react';
import {splitAddresses, TemplatePicker} from './ComposeEmail.jsx';
import './deal-composer.css';

const modes=[['note','Примечание'],['chat','Чат'],['call','Звонок'],['email','Письмо'],['message','Сообщение']];
const placeholders={note:'Написать примечание…',chat:'Сообщение коллегам по этой сделке…',call:'Что обсудили по телефону?',email:'Содержание письма…',message:'Содержание переписки…'};

// «Письмо» sends a real letter when a mailbox is connected (mail.mailboxes) and the user may send;
// «Записать без отправки» keeps the old manual record for letters written elsewhere.
export default function DealComposer({note,setNote,onAddNote,onAddCommunication,onSendEmail,onSendChat,mail,recipients=[],colleagues=[],defaultColleague=null,onError}){
  const mailboxes=mail?.can_send?mail.mailboxes||[]:[];
  const [mode,setMode]=useState('note'),[direction,setDirection]=useState('outgoing'),[subject,setSubject]=useState(''),[body,setBody]=useState(''),[busy,setBusy]=useState(false);
  const [chatTo,setChatTo]=useState(defaultColleague&&colleagues.some(user=>Number(user.id)===Number(defaultColleague))?[Number(defaultColleague)]:[]);
  const [mailboxId,setMailboxId]=useState(''),[to,setTo]=useState(recipients.join(', ')),[cc,setCc]=useState(''),[recordOnly,setRecordOnly]=useState(false);
  const sending=mode==='email'&&mailboxes.length>0&&!recordOnly;
  const content=mode==='note'?note:body;
  const ready=!!content.trim()&&(!sending||splitAddresses(to).length>0&&!!subject.trim())&&(mode!=='chat'||chatTo.length>0);
  const toggleChat=id=>setChatTo(list=>list.includes(id)?list.filter(item=>item!==id):[...list,id]);
  const submit=async event=>{
    event.preventDefault();
    if(busy||!ready)return;
    setBusy(true);
    try{
      if(mode==='note')await onAddNote();
      else if(mode==='chat'){if(await onSendChat({body:body.trim(),to:chatTo.length===colleagues.length&&colleagues.length>1?'all':chatTo}))setBody('')}
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
      <TemplatePicker subject={subject} text={body} onPick={item=>{setSubject(item.subject);setBody(item.text)}}/>
      <label>Тема<input aria-label="Тема письма" maxLength={998} value={subject} onChange={event=>setSubject(event.target.value)}/></label>
    </div>}
    {mode==='chat'&&<div className="deal-compose-chat" role="group" aria-label="Кому"><span>Кому:</span>{colleagues.length>1&&<button type="button" className={chatTo.length===colleagues.length?'active':''} onClick={()=>setChatTo(chatTo.length===colleagues.length?[]:colleagues.map(user=>Number(user.id)))}>Всем</button>}{colleagues.map(user=><button type="button" key={user.id} className={chatTo.includes(Number(user.id))?'active':''} aria-pressed={chatTo.includes(Number(user.id))} onClick={()=>toggleChat(Number(user.id))}>{user.name}</button>)}{colleagues.length===0&&<em>Нет других сотрудников</em>}</div>}
    {mode!=='note'&&mode!=='chat'&&!sending&&<div className="deal-compose-meta"><label>Направление<select aria-label="Направление коммуникации" value={direction} onChange={event=>setDirection(event.target.value)}><option value="outgoing">Исходящее</option><option value="incoming">Входящее</option></select></label>{mode==='email'&&<label className="deal-compose-subject">Тема<input aria-label="Тема письма" maxLength={255} value={subject} onChange={event=>setSubject(event.target.value)}/></label>}</div>}
    <div className="deal-compose-entry"><textarea aria-label={mode==='note'?'Написать примечание':mode==='chat'?'Сообщение в чат':sending?'Текст письма':'Содержание коммуникации'} placeholder={placeholders[mode]} maxLength={sending?50000:10000} value={content} onChange={event=>mode==='note'?setNote(event.target.value):setBody(event.target.value)}/><button className="blue-btn" disabled={busy||!ready}>{busy?(sending||mode==='chat'?'Отправляем…':'Сохраняем…'):mode==='note'?'Добавить':sending||mode==='chat'?'Отправить':'Записать'}</button></div>
    {mode==='email'&&mailboxes.length>0&&<label className="deal-compose-record"><input type="checkbox" checked={recordOnly} onChange={event=>setRecordOnly(event.target.checked)}/> Записать без отправки (письмо уже отправлено из другой программы)</label>}
    {mode==='chat'&&<small>Сообщение видят только сотрудники: оно появится у получателей в «Сообщениях» и в ленте сделки.</small>}
    {mode!=='note'&&mode!=='chat'&&!sending&&<small>{mode==='email'&&mailboxes.length===0?'Запись для истории сделки. Чтобы отправлять письма клиенту, администратор подключает ящик в «Настройки → Почта».':'Запись для истории сделки. Сообщение не отправляется клиенту.'}</small>}
  </form>;
}
