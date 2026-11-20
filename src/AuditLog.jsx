import React,{useEffect,useState} from 'react';
import {Search} from 'lucide-react';
import './security.css';

const labels={
  'auth.setup':'Создан первый администратор','auth.login':'Вход','auth.login_failed':'Неудачный вход','auth.login_blocked':'Вход заблокирован лимитом','auth.logout':'Выход',
  'auth.password_changed':'Сменил свой пароль','auth.password_change_failed':'Неудачная смена пароля','auth.sessions_revoked':'Завершил свои другие сеансы','auth.2fa_enabled':'Включил 2FA','auth.2fa_disabled':'Выключил 2FA',
  'user.created':'Создан сотрудник','user.updated':'Изменён сотрудник','user.disabled':'Доступ отключён','user.enabled':'Доступ включён','user.password_reset':'Пароль задан администратором','user.sessions_revoked':'Сеансы сотрудника завершены','user.2fa_reset':'2FA сброшена администратором',
  'export.deals':'Экспорт сделок','export.contacts':'Экспорт контактов','export.companies':'Экспорт компаний','import.deals':'Импорт сделок','import.contacts':'Импорт контактов','import.companies':'Импорт компаний',
  'attachment.downloaded':'Скачан файл','record.purged':'Удалено навсегда','inbox.rejected':'Заявка отклонена','inbox.purged':'Заявка удалена навсегда',
  'api_key.created':'Создан ключ API','api_key.revoked':'Отозван ключ API','webhook.created':'Создан webhook','webhook.updated':'Изменён webhook','webhook.deleted':'Удалён webhook','webhook.secret_rotated':'Заменён секрет webhook',
  'cli.reset-password':'Пароль сброшен на сервере','cli.reset-2fa':'2FA сброшена на сервере','cli.enable':'Доступ включён на сервере'
};
const filters=[['','Все события'],['auth','Входы и пароли'],['user','Сотрудники и права'],['export','Экспорт'],['import','Импорт'],['attachment','Файлы'],['record','Удаление навсегда'],['inbox','Заявки'],['api_key','Ключи API'],['webhook','Webhooks'],['cli','Команды на сервере']];
const warning=action=>['auth.login_failed','auth.login_blocked','auth.password_change_failed','user.disabled','record.purged','inbox.purged'].includes(action)||action.startsWith('export.');
const time=value=>new Date(value.replace(' ','T')+'Z').toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});

export default function AuditLog({api,onError}){
  const [filter,setFilter]=useState(''),[query,setQuery]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(1),[data,setData]=useState({items:[],total:0,pages:1});
  useEffect(()=>{const timer=setTimeout(()=>{setSearch(query.trim());setPage(1)},300);return()=>clearTimeout(timer)},[query]);
  useEffect(()=>{api(`/audit-log?page=${page}&page_size=50&action=${encodeURIComponent(filter)}&q=${encodeURIComponent(search)}`).then(setData).catch(onError)},[filter,search,page]);
  return <div className="settings-body audit-page">
    <div className="settings-section-heading"><div><h2>Журнал безопасности</h2><p>Входы, изменения прав, выгрузки, скачивание файлов и удаление данных. Записи хранятся год.</p></div></div>
    <section className="settings-card">
      <div className="audit-toolbar"><label><Search size={16}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Email, объект, IP" aria-label="Поиск по журналу"/></label><select aria-label="Тип событий" value={filter} onChange={event=>{setFilter(event.target.value);setPage(1)}}>{filters.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><span>Всего: {data.total}</span></div>
      <div className="audit-table">
        <div className="audit-row audit-head"><span>ВРЕМЯ</span><span>КТО</span><span>СОБЫТИЕ</span><span>ОБЪЕКТ</span><span>ПОДРОБНОСТИ</span><span>IP</span></div>
        {data.items.map(item=><div className={'audit-row'+(warning(item.action)?' warning':'')} key={item.id}><span>{time(item.created_at)}</span><span title={item.actor}>{item.user_name||item.actor||'—'}</span><span>{labels[item.action]||item.action}</span><span title={item.target}>{item.target||'—'}</span><span title={item.details}>{item.details||'—'}</span><span>{item.ip||'—'}</span></div>)}
        {!data.items.length&&<p className="settings-no-results">Событий не найдено</p>}
      </div>
      {data.pages>1&&<div className="audit-pages"><button disabled={page<=1} onClick={()=>setPage(page-1)}>← Назад</button><span>{page} из {data.pages}</span><button disabled={page>=data.pages} onClick={()=>setPage(page+1)}>Вперёд →</button></div>}
    </section>
  </div>;
}
