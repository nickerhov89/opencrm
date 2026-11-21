import React, {useEffect, useState} from 'react';
import {Plus, Power, Trash2, Pencil} from 'lucide-react';
import './integrations.css';
import './mail-settings.css';
import {taskTypes} from './task-types.js';

const originNames={api:'API (портал, интеграции)',inbox:'Заявки из «Неразобранного»',manual:'Созданные сотрудником вручную'};
const empty={name:'',pipeline_id:'',origins:['api'],sources:[],conditions:[],user_ids:[],task_title:'Взять в работу',task_type:'Связаться',sort_order:0,active:false};

// Settings → Распределение: new deals go to managers in turn, like the amoCRM «Распределение сделок» widget.
export default function DistributionSettings({api,onError,users,pipelines,customFields}){
  const [rules,setRules]=useState([]),[form,setForm]=useState(null),[busy,setBusy]=useState(false);
  const sourceField=customFields.find(field=>field.entity_type==='deal'&&/^источник$/i.test(String(field.name).trim()));
  let sourceOptions=[];try{sourceOptions=JSON.parse(sourceField?.options_json||'[]')}catch{}
  const staff=users.filter(user=>!user.disabled);
  const dealFields=customFields.filter(field=>field.entity_type==='deal'&&field.id!==sourceField?.id);
  const fieldName=id=>customFields.find(field=>Number(field.id)===Number(id))?.name||`Поле #${id}`;
  const setCondition=(index,patch)=>setForm(old=>({...old,conditions:old.conditions.map((item,i)=>i===index?{...item,...patch}:item)}));
  const load=async()=>setRules(await api('/distribution/rules'));
  useEffect(()=>{load().catch(onError)},[]);
  const action=async work=>{setBusy(true);try{await work();await load();return true}catch(error){onError(error);return false}finally{setBusy(false)}};
  const set=(key,value)=>setForm(old=>({...old,[key]:value}));
  const toggle=(key,value)=>setForm(old=>({...old,[key]:old[key].includes(value)?old[key].filter(item=>item!==value):[...old[key],value]}));
  const save=event=>{event.preventDefault();const body={...form,conditions:form.conditions.map(({field_id,values})=>({field_id,values})),pipeline_id:form.pipeline_id===''?null:Number(form.pipeline_id),sort_order:Number(form.sort_order)||0};void action(async()=>{await api(form.id?'/distribution/rules/'+form.id:'/distribution/rules',{method:form.id?'PATCH':'POST',body});setForm(null)})};
  const pipelineName=id=>id==null?'Все воронки':pipelines.find(item=>Number(item.id)===Number(id))?.name||`Воронка #${id}`;
  return <div className="settings-body integrations-page mail-settings">
    <div className="settings-section-heading"><div><h2>Распределение сделок</h2><p>Новые сделки по очереди уходят менеджерам: ответственным за сделку, её контакт, компанию и открытые задачи. После этого ставится задача правила.</p></div><button className="blue-btn" onClick={()=>setForm(form?null:{...empty})}><Plus size={15}/> НОВОЕ ПРАВИЛО</button></div>
    <div className="integrations-note">Правила проверяются сверху вниз, срабатывает первое подходящее по воронке и источнику (поле «Источник» сделки). Распределение идёт через несколько секунд после создания, когда портал уже записал поля. Сделки, загруженные из amoCRM со старой датой, не перераспределяются.</div>
    {form&&<section className="settings-card integrations-card"><div className="settings-card-title"><div><h2>{form.id?'Правило':'Новое правило'}</h2><p>Выключенное правило ничего не меняет.</p></div></div>
      <form onSubmit={save} className="integrations-form mail-form">
        <label>Название<input value={form.name} onChange={event=>set('name',event.target.value)} maxLength={120} placeholder="Например, Автоаутрич" required/></label>
        <label>Воронка<select value={form.pipeline_id??''} onChange={event=>set('pipeline_id',event.target.value)}><option value="">Все воронки</option>{pipelines.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <fieldset><legend>Какие сделки</legend>{Object.entries(originNames).map(([key,label])=><label key={key}><input type="checkbox" checked={form.origins.includes(key)} onChange={()=>toggle('origins',key)}/>{label}</label>)}</fieldset>
        <fieldset><legend>Источник {sourceOptions.length?'':'(значения через запятую)'}</legend>{sourceOptions.length?sourceOptions.map(option=><label key={option}><input type="checkbox" checked={form.sources.includes(option)} onChange={()=>toggle('sources',option)}/>{option}</label>):<input value={form.sources.join(', ')} onChange={event=>set('sources',event.target.value.split(',').map(item=>item.trim()).filter(Boolean))} placeholder="Пусто — любой"/>}<small>Ничего не отмечено — любой источник.</small></fieldset>
        <fieldset><legend>Условия по другим полям</legend>{form.conditions.map((condition,index)=><div className="mail-form-pair" key={index}><label>Поле<select value={condition.field_id} onChange={event=>setCondition(index,{field_id:Number(event.target.value)})}>{dealFields.map(field=><option key={field.id} value={field.id}>{field.name}</option>)}</select></label><label>Значение (несколько — через запятую)<input value={condition.text??condition.values.join(', ')} onChange={event=>setCondition(index,{text:event.target.value,values:event.target.value.split(',').map(item=>item.trim()).filter(Boolean)})} placeholder="Например, Автоаутрич EN"/></label><button type="button" onClick={()=>setForm(old=>({...old,conditions:old.conditions.filter((item,i)=>i!==index)}))} title="Убрать условие"><Trash2 size={15}/></button></div>)}{dealFields.length>0&&<button type="button" onClick={()=>setForm(old=>({...old,conditions:[...old.conditions,{field_id:Number(dealFields[0].id),values:[]}]}))}><Plus size={14}/> Добавить условие</button>}<small>Все условия должны выполняться. Регистр букв не важен.</small></fieldset>
        <fieldset><legend>Сотрудники по очереди</legend>{staff.map(user=><label key={user.id}><input type="checkbox" checked={form.user_ids.includes(Number(user.id))} onChange={()=>toggle('user_ids',Number(user.id))}/>{user.name}</label>)}</fieldset>
        <div className="mail-form-pair"><label>Задача после распределения<input value={form.task_title} onChange={event=>set('task_title',event.target.value)} maxLength={500} placeholder="Пусто — без задачи"/></label><label>Тип<select value={form.task_type} onChange={event=>set('task_type',event.target.value)}>{taskTypes.map(type=><option key={type}>{type}</option>)}</select></label></div>
        <label>Порядок<input inputMode="numeric" value={form.sort_order} onChange={event=>set('sort_order',event.target.value)}/></label>
        <label><span><input type="checkbox" checked={form.active} onChange={event=>set('active',event.target.checked)}/> Правило включено</span></label>
        <button className="blue-btn" disabled={busy||!form.user_ids.length||!form.origins.length}>{busy?'СОХРАНЯЕМ…':'СОХРАНИТЬ'}</button>
      </form></section>}
    <section className="settings-card integrations-card"><div className="settings-card-title"><div><h2>Правила</h2><p>Срок задачи — конец дня создания сделки (Москва).</p></div></div>
      <div className="integrations-list">{rules.map(rule=><div className="integrations-row mail-box-row" key={rule.id}><div><strong>{rule.sort_order}. {rule.name}{rule.active?'':' · выключено'}</strong><small>{pipelineName(rule.pipeline_id)} · {rule.origins.map(key=>originNames[key]).join(', ')} · источник: {rule.sources.length?rule.sources.join(', '):'любой'}{rule.conditions.map(item=>` · ${fieldName(item.field_id)}: ${item.values.join(', ')||'пусто'}`).join('')}</small><small>По очереди: {rule.users.join(' → ')} · распределено: {rule.assigned}{rule.task_title?` · задача «${rule.task_type}: ${rule.task_title}»`:''}</small></div>
        <div className="mail-box-actions"><button type="button" disabled={busy} onClick={()=>setForm({...rule,pipeline_id:rule.pipeline_id??'',user_ids:rule.user_ids.map(Number)})}><Pencil size={15}/> Изменить</button><button type="button" disabled={busy} onClick={()=>void action(()=>api('/distribution/rules/'+rule.id,{method:'PATCH',body:{active:!rule.active}}))}><Power size={15}/> {rule.active?'Выключить':'Включить'}</button><button type="button" disabled={busy} onClick={()=>{if(window.confirm(`Удалить правило «${rule.name}»?`))void action(()=>api('/distribution/rules/'+rule.id,{method:'DELETE'}))}}><Trash2 size={15}/> Удалить</button></div></div>)}
        {rules.length===0&&<div className="empty">Правил нет: новые сделки остаются у того, кого назначил создатель.</div>}</div>
    </section>
  </div>;
}
