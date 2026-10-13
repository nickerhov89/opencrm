import React,{useState} from 'react';
import './deal-composer.css';

const modes=[['note','Примечание'],['call','Звонок'],['email','Письмо'],['message','Сообщение']];
const placeholders={note:'Написать примечание…',call:'Что обсудили по телефону?',email:'Содержание письма…',message:'Содержание переписки…'};

export default function DealComposer({note,setNote,onAddNote,onAddCommunication,onError}){
  const [mode,setMode]=useState('note'),[direction,setDirection]=useState('outgoing'),[subject,setSubject]=useState(''),[body,setBody]=useState(''),[busy,setBusy]=useState(false);
  const content=mode==='note'?note:body;
  const submit=async event=>{
    event.preventDefault();
    if(busy||!content.trim())return;
    setBusy(true);
    try{
      if(mode==='note')await onAddNote();
      else{await onAddCommunication({kind:mode,direction,subject:mode==='email'?subject.trim():'',body:body.trim()});setBody('');setSubject('')}
    }catch(error){onError(error)}finally{setBusy(false)}
  };
  return <form className="note-compose deal-compose" onSubmit={submit}>
    <div className="deal-compose-modes" role="tablist" aria-label="Тип записи">
      {modes.map(([key,label])=><button type="button" role="tab" aria-selected={mode===key} className={mode===key?'active':''} key={key} onClick={()=>setMode(key)}>{label}</button>)}
    </div>
    {mode!=='note'&&<div className="deal-compose-meta"><label>Направление<select aria-label="Направление коммуникации" value={direction} onChange={event=>setDirection(event.target.value)}><option value="outgoing">Исходящее</option><option value="incoming">Входящее</option></select></label>{mode==='email'&&<label className="deal-compose-subject">Тема<input aria-label="Тема письма" maxLength={255} value={subject} onChange={event=>setSubject(event.target.value)}/></label>}</div>}
    <div className="deal-compose-entry"><textarea aria-label={mode==='note'?'Написать примечание':'Содержание коммуникации'} placeholder={placeholders[mode]} maxLength={10000} value={content} onChange={event=>mode==='note'?setNote(event.target.value):setBody(event.target.value)}/><button className="blue-btn" disabled={busy||!content.trim()}>{busy?'Сохраняем…':mode==='note'?'Добавить':'Записать'}</button></div>
    {mode!=='note'&&<small>Запись для истории сделки. Сообщение не отправляется клиенту.</small>}
  </form>;
}
