import React,{useState} from 'react';
import {X} from 'lucide-react';
import './new-deal-form.css';

export default function NewDealForm({stages,users,currentUser,contacts,companies,onClose,onSave}){
  const activeStages=stages.filter(stage=>stage.kind==='active');
  const [form,setForm]=useState({name:'',stage_id:activeStages[0]?.id||'',owner_id:currentUser.id,amount:'',source:'',tags:'',description:'',contact_mode:'none',contact_id:'',contact_name:'',contact_phone:'',contact_email:'',company_mode:'none',company_id:'',company_name:'',company_address:''});
  const [busy,setBusy]=useState(false);
  const set=(key,value)=>setForm(current=>({...current,[key]:value}));
  const field=(label,key,props={})=><label>{label}<input value={form[key]} onChange={event=>set(key,event.target.value)} {...props}/></label>;
  const select=(label,key,items,props={})=><label>{label}<select value={form[key]} onChange={event=>set(key,event.target.value)} {...props}>{items.map(([value,title])=><option value={value} key={value}>{title}</option>)}</select></label>;
  const submit=async event=>{
    event.preventDefault();
    if(busy||!form.name.trim()||!activeStages.length)return;
    setBusy(true);
    try{
      const data={name:form.name.trim(),stage_id:Number(form.stage_id),owner_id:Number(form.owner_id),amount:Number(form.amount)||0,source:form.source,tags:form.tags,description:form.description,
        contact_id:form.contact_mode==='existing'?Number(form.contact_id)||null:null,contact_name:form.contact_mode==='new'?form.contact_name:'',contact_phone:form.contact_mode==='new'?form.contact_phone:'',contact_email:form.contact_mode==='new'?form.contact_email:'',
        company_id:form.company_mode==='existing'?Number(form.company_id)||null:null,company_name:form.company_mode==='new'?form.company_name:'',company_address:form.company_mode==='new'?form.company_address:''};
      await onSave(data);
    }finally{setBusy(false)}
  };
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose()}}><aside className="modal new-deal-panel" role="dialog" aria-modal="true" aria-label="Новая сделка">
    <div className="modal-head"><h2>Новая сделка</h2><button type="button" aria-label="Закрыть" onClick={onClose} disabled={busy}><X size={19}/></button></div>
    <form className="modal-form" onSubmit={submit}>
      {field('Название сделки','name',{required:true,autoFocus:true,maxLength:255})}
      {select('Этап','stage_id',activeStages.map(stage=>[stage.id,stage.name]))}
      {field('Бюджет, ₽','amount',{type:'number',min:0,step:1})}
      {select('Ответственный','owner_id',users.map(user=>[user.id,user.name]))}
      <fieldset className="new-deal-group"><legend>Контакт</legend>{select('Выбор контакта','contact_mode',[['none','Без контакта'],['existing','Из списка'],['new','Создать новый']])}{form.contact_mode==='existing'&&select('Контакт','contact_id',[['','Выберите контакт'],...contacts.map(contact=>[contact.id,contact.name])],{required:true})}{form.contact_mode==='new'&&<>{field('Имя контакта','contact_name',{required:true,maxLength:255})}{field('Телефон','contact_phone',{type:'tel',maxLength:80})}{field('Email','contact_email',{type:'email',maxLength:254})}</>}</fieldset>
      <fieldset className="new-deal-group"><legend>Компания</legend>{select('Выбор компании','company_mode',[['none','Без компании'],['existing','Из списка'],['new','Создать новую']])}{form.company_mode==='existing'&&select('Компания','company_id',[['','Выберите компанию'],...companies.map(company=>[company.id,company.name])],{required:true})}{form.company_mode==='new'&&<>{field('Название компании','company_name',{required:true,maxLength:255})}{field('Адрес','company_address',{maxLength:500})}</>}</fieldset>
      {field('Источник','source',{maxLength:255,placeholder:'Сайт, рекомендация…'})}
      {field('Теги','tags',{maxLength:1000,placeholder:'Через запятую'})}
      <label>Описание<textarea value={form.description} maxLength={10000} onChange={event=>set('description',event.target.value)}/></label>
      <div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>Отмена</button><button className="blue-btn" type="submit" disabled={busy||!form.name.trim()||!activeStages.length}>{busy?'Создаём…':'Создать сделку'}</button></div>
      {!activeStages.length&&<p className="new-deal-error">В этой воронке нет активного этапа.</p>}
    </form>
  </aside></div>;
}
