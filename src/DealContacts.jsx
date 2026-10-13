import React,{useEffect,useMemo,useState} from 'react';
import {ChevronDown,Mail,Phone,Plus,UserRound,X} from 'lucide-react';
import './deal-contacts.css';

export default function DealContacts({deal,contacts,onOpen,onAdd,onCreate,onRemove}){
  const [adding,setAdding]=useState(false),[search,setSearch]=useState(''),[busy,setBusy]=useState(false);
  const [creating,setCreating]=useState(false),[draft,setDraft]=useState({name:'',phone:'',email:'',position:''});
  const [expandedId,setExpandedId]=useState(deal.contact_id);
  const linked=deal.contacts||[];
  useEffect(()=>setExpandedId(deal.contact_id),[deal.id,deal.contact_id]);
  const options=useMemo(()=>contacts.filter(contact=>!linked.some(item=>item.id===contact.id)&&contact.name.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))).slice(0,30),[contacts,linked,search]);
  const add=async id=>{setBusy(true);try{if(await onAdd(id)){setAdding(false);setSearch('')}}finally{setBusy(false)}};
  const create=async event=>{event.preventDefault();if(!draft.name.trim())return;setBusy(true);try{if(await onCreate(draft)){setAdding(false);setCreating(false);setSearch('');setDraft({name:'',phone:'',email:'',position:''})}}finally{setBusy(false)}};
  const remove=async id=>{setBusy(true);try{await onRemove(id)}finally{setBusy(false)}};
  return <section className="deal-contacts">
    <div className="deal-contacts-head"><h2>КОНТАКТЫ <span>{linked.length}</span></h2><button onClick={()=>setAdding(open=>!open)}><Plus size={14}/> Добавить</button></div>
    {linked.map(contact=>{
      const expanded=expandedId===contact.id;
      return <div className={'deal-contact'+(expanded?' is-expanded':'')} key={contact.id}>
        <div className="deal-contact-top">
          <button className="deal-contact-expand" aria-label={`${expanded?'Свернуть':'Показать'} данные: ${contact.name}`} aria-expanded={expanded} onClick={()=>setExpandedId(expanded?null:contact.id)}><ChevronDown size={15}/></button>
          <button className="deal-contact-open" onClick={()=>onOpen(contact.id)}><span className="deal-related-avatar"><UserRound size={19}/></span><span><b>{contact.name}</b><small>{contact.company_name||contact.position||'Контакт'}{contact.id===deal.contact_id?' · основной':''}</small></span></button>
          <div className="deal-contact-actions">{contact.phone&&<a href={`tel:${contact.phone.replace(/[^+\d]/g,'')}`} aria-label={`Позвонить: ${contact.name}`} title={contact.phone}><Phone size={15}/></a>}{contact.email&&<a href={`mailto:${contact.email.replace(/[\r\n?#]/g,'')}`} aria-label={`Написать письмо: ${contact.name}`} title={contact.email}><Mail size={15}/></a>}<button className="deal-contact-remove" aria-label={`Убрать связь с ${contact.name}`} title="Убрать из сделки" disabled={busy} onClick={()=>remove(contact.id)}><X size={15}/></button></div>
        </div>
        {expanded&&<div className="deal-contact-details">{contact.position&&<div><span>Должность</span><b>{contact.position}</b></div>}{contact.phone&&<div><span>Телефон</span><a href={`tel:${contact.phone.replace(/[^+\d]/g,'')}`}>{contact.phone}</a></div>}{contact.email&&<div><span>Email</span><a href={`mailto:${contact.email.replace(/[\r\n?#]/g,'')}`}>{contact.email}</a></div>}{contact.company_name&&<div><span>Компания</span><b>{contact.company_name}</b></div>}</div>}
      </div>;
    })}
    {!linked.length&&<p>Контакты не привязаны</p>}
    {adding&&<div className="deal-contact-picker">{creating?<form className="deal-contact-create" onSubmit={create}><strong>Новый контакт</strong><input autoFocus required maxLength={255} placeholder="Имя *" aria-label="Имя нового контакта" value={draft.name} onChange={event=>setDraft(current=>({...current,name:event.target.value}))}/><input type="tel" maxLength={80} placeholder="Телефон" aria-label="Телефон нового контакта" value={draft.phone} onChange={event=>setDraft(current=>({...current,phone:event.target.value}))}/><input type="email" maxLength={254} placeholder="Email" aria-label="Email нового контакта" value={draft.email} onChange={event=>setDraft(current=>({...current,email:event.target.value}))}/><input maxLength={255} placeholder="Должность" aria-label="Должность нового контакта" value={draft.position} onChange={event=>setDraft(current=>({...current,position:event.target.value}))}/><div className="deal-contact-create-actions"><button type="button" disabled={busy} onClick={()=>setCreating(false)}>Назад</button><button type="submit" disabled={busy||!draft.name.trim()}>{busy?'Создаём…':'Создать и привязать'}</button></div></form>:<><input autoFocus placeholder="Найти контакт" value={search} onChange={event=>setSearch(event.target.value)} aria-label="Найти контакт"/><div>{options.map(contact=><button key={contact.id} disabled={busy} onClick={()=>add(contact.id)}><b>{contact.name}</b><small>{contact.company_name||contact.email||''}</small></button>)}{!options.length&&<span>Подходящих контактов нет</span>}</div><button className="deal-contact-create-trigger" onClick={()=>{setDraft(current=>({...current,name:search.trim()}));setCreating(true)}} disabled={busy}><Plus size={13}/> Создать новый контакт</button></>}<button className="deal-contact-picker-close" onClick={()=>{setAdding(false);setCreating(false)}}>Закрыть</button></div>}
  </section>;
}
