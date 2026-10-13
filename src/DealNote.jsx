import React,{useState} from 'react';
import {MessageSquareText,Pin,PinOff} from 'lucide-react';
import './deal-note.css';

export default function DealNote({note,onPin,formatDate}){
  const [busy,setBusy]=useState(false);
  const pinned=Boolean(note.pinned);
  const toggle=async()=>{setBusy(true);try{await onPin(note.id,!pinned)}finally{setBusy(false)}};
  return <div className={'timeline-item note-card deal-note'+(pinned?' is-pinned':'')}>
    <span className="timeline-icon"><MessageSquareText size={17}/></span>
    <div className="deal-note-body"><div className="deal-note-head"><small>{formatDate(note.created_at)} · {note.author||'Система'}</small><button disabled={busy} onClick={toggle} title={pinned?'Открепить примечание':'Закрепить примечание'} aria-label={pinned?'Открепить примечание':'Закрепить примечание'}>{pinned?<PinOff size={14}/>:<Pin size={14}/>}</button></div><p>{note.body}</p></div>
  </div>;
}
