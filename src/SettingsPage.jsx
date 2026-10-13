import React, {useEffect, useState} from 'react';
import {Menu, Plus, LogOut, ChevronRight} from 'lucide-react';
import TrashDeals from './TrashDeals.jsx';
import UserSettings from './UserSettings.jsx';
import IntegrationSettings from './IntegrationSettings.jsx';
import './settings.css';

const entityNames={deal:'Сделки',contact:'Контакты',company:'Компании'};
const fieldNames={text:'Текст',number:'Число',date:'Дата',url:'Ссылка',select:'Список'};

export default function SettingsPage({auth,users,groups,pipelines,pipeline,stages,customFields,api,onError,onAccountChange,onRefresh,onMenu,onAddCustomField,onEditCustomField,onAddUser,onEditUser,onAddPipeline,onEditPipeline,onAddStage,onEditStage,onLogout}) {
  const [section,setSection]=useState('general');
  const [account,setAccount]=useState('OpenCRM');
  const [draft,setDraft]=useState('OpenCRM');
  const [saving,setSaving]=useState(false);
  const [selected,setSelected]=useState(pipeline);
  const [localStages,setLocalStages]=useState(stages);
  const isAdmin=auth.role==='admin';
  useEffect(()=>{api('/settings').then(data=>{setAccount(data.name);setDraft(data.name)}).catch(onError)},[]);
  useEffect(()=>{if(!selected&&pipeline)setSelected(pipeline)},[pipeline]);
  useEffect(()=>{if(selected===pipeline)setLocalStages(stages)},[stages,pipeline,selected]);
  useEffect(()=>{if(!selected||selected===pipeline)return;api('/stages?pipeline_id='+selected).then(setLocalStages).catch(onError)},[selected,pipelines,stages]);
  const saveAccount=async e=>{e.preventDefault();setSaving(true);try{const result=await api('/settings',{method:'PATCH',body:{name:draft}});setAccount(result.name);setDraft(result.name);onAccountChange?.(result.name)}catch(err){onError(err)}finally{setSaving(false)}};
  const sections=[['general','Общие настройки'],['users','Пользователи'],['pipelines','Воронки и этапы'],['fields','Поля'],...(isAdmin?[['integrations','Интеграции']]:[]),['trash','Корзина']];
  const title=sections.find(([key])=>key===section)?.[1];
  return <div className="settings-layout">
    <aside className="settings-nav"><h1>НАСТРОЙКИ</h1>{sections.map(([key,label])=><button key={key} className={section===key?'active':''} onClick={()=>setSection(key)}>{label}{section===key&&<ChevronRight size={15}/>}</button>)}<div className="settings-nav-bottom"><button onClick={onLogout}><LogOut size={16}/> Выйти из аккаунта</button></div></aside>
    <div className="settings-main"><header className="settings-toolbar"><button className="settings-menu" onClick={onMenu} aria-label="Открыть меню"><Menu size={22}/></button><strong>{title.toUpperCase()}</strong><span>{account}</span></header>
      {section==='general'&&<div className="settings-body"><section className="settings-card general-card"><div className="settings-card-title"><h2>Основные настройки</h2><p>Название рабочего пространства видно команде на рабочем столе.</p></div><form onSubmit={saveAccount}><div className="settings-form-row"><label htmlFor="account-name">Название аккаунта</label><input id="account-name" value={draft} onChange={e=>setDraft(e.target.value)} maxLength={120} required disabled={!isAdmin}/></div><div className="settings-form-row"><span>Адрес аккаунта</span><span className="settings-readonly">{window.location.origin}</span></div><div className="settings-form-row"><span>Ваш профиль</span><span className="settings-readonly">{auth.name} · {auth.email}</span></div><div className="settings-form-row"><span>Права</span><span className="settings-readonly">{isAdmin?'Администратор':'Сотрудник'}</span></div>{isAdmin&&<div className="settings-save"><button className="blue-btn" disabled={saving||draft.trim()===account}>{saving?'СОХРАНЯЕМ…':'СОХРАНИТЬ'}</button></div>}</form></section></div>}
      {section==='users'&&<UserSettings users={users} groups={groups} isAdmin={isAdmin} api={api} onError={onError} onRefresh={onRefresh} onAddUser={onAddUser} onEditUser={onEditUser}/>}
      {section==='pipelines'&&<div className="settings-body"><div className="settings-section-heading"><div><h2>Воронки и этапы</h2><p>Структура продаж для каждого направления.</p></div>{isAdmin&&<button className="blue-btn" onClick={onAddPipeline}><Plus size={15}/> ДОБАВИТЬ ВОРОНКУ</button>}</div><div className="settings-pipeline-layout"><section className="settings-card settings-pipeline-list"><div className="settings-card-title"><h3>Воронки</h3></div>{pipelines.map(p=><div className={'settings-pipeline-item '+(selected===p.id?'selected':'')} key={p.id}><button onClick={()=>setSelected(p.id)}>{p.name}</button>{isAdmin&&<button className="settings-edit" onClick={()=>onEditPipeline(p)}>Изменить</button>}</div>)}</section><section className="settings-card settings-stage-list"><div className="settings-card-title"><h3>Этапы {pipelines.find(p=>p.id===selected)?.name||''}</h3>{isAdmin&&<button onClick={()=>onAddStage(selected)}><Plus size={15}/> Добавить этап</button>}</div>{localStages.map(s=><button className="settings-stage-row" key={s.id} onClick={()=>isAdmin&&onEditStage(s)} disabled={!isAdmin}><i style={{background:s.color}}/><span>{s.name}</span><small>{s.kind==='won'?'Успех':s.kind==='lost'?'Отказ':'В работе'}</small></button>)}</section></div></div>}
      {section==='fields'&&<div className="settings-body"><div className="settings-section-heading"><div><h2>Дополнительные поля</h2><p>Настраиваемые поля для сделок, контактов и компаний.</p></div>{isAdmin&&<button className="blue-btn" onClick={onAddCustomField}><Plus size={15}/> ДОБАВИТЬ ПОЛЕ</button>}</div><section className="settings-card settings-fields"><div className="settings-fields-head"><span>НАЗВАНИЕ</span><span>РАЗДЕЛ</span><span>ТИП</span></div>{customFields.map(f=><div className="settings-fields-row" key={f.id}><button disabled={!isAdmin} onClick={()=>onEditCustomField(f)}>{f.name}</button><span>{entityNames[f.entity_type]}</span><span>{fieldNames[f.field_type]}</span></div>)}{!customFields.length&&<p className="settings-no-results">Дополнительных полей пока нет</p>}</section></div>}
      {section==='integrations'&&isAdmin&&<IntegrationSettings api={api} onError={onError}/>}
      {section==='trash'&&<TrashDeals api={api} onError={onError} onRefresh={onRefresh}/>}
    </div>
  </div>;
}
