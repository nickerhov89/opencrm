import React, {useState} from 'react';
import './quick-deal.css';

const empty={name:'',amount:'',contact_name:'',contact_phone:'',contact_email:'',company_name:'',company_address:'',source:'',tags:''};

export default function QuickDealForm({stageId,onCancel,onSubmit}){
  const [form,setForm]=useState(empty),[busy,setBusy]=useState(false),[advanced,setAdvanced]=useState(false);
  const set=(field,value)=>setForm(current=>({...current,[field]:value}));
  const input=(field,placeholder,props={})=><input key={field} aria-label={placeholder} placeholder={placeholder} value={form[field]} onChange={event=>set(field,event.target.value)} {...props}/>;
  const submit=async event=>{event.preventDefault();setBusy(true);try{await onSubmit({...form,stage_id:stageId,amount:Number(form.amount)||0})}finally{setBusy(false)}};
  return <form className="quick-deal-form" onSubmit={submit}>
    {input('name','Название',{autoFocus:true,required:true,maxLength:255})}
    {input('amount','0 ₽',{type:'number',min:0,step:1})}
    <div className="quick-deal-group">{input('contact_name','Контакт: Имя',{maxLength:255})}{input('contact_phone','Контакт: Телефон',{type:'tel',maxLength:80})}{input('contact_email','Контакт: Email',{type:'email',maxLength:254})}</div>
    <div className="quick-deal-group">{input('company_name','Компания: Название',{maxLength:255})}{input('company_address','Компания: Адрес',{maxLength:500})}</div>
    {advanced&&<div className="quick-deal-group">{input('source','Источник',{maxLength:255})}{input('tags','Теги через запятую',{maxLength:1000})}</div>}
    <div className="quick-deal-actions"><button className="quick-deal-submit" disabled={busy||!form.name.trim()}>{busy?'Добавляем…':'Добавить'}</button><button type="button" onClick={onCancel} disabled={busy}>Отменить</button><button type="button" className="quick-deal-settings" onClick={()=>setAdvanced(value=>!value)} aria-expanded={advanced}>Настройки ⚙</button></div>
  </form>;
}
