import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, ChevronDown, ListFilter, Menu, Search, Settings2, X } from 'lucide-react';
import './dashboard.css';

const money = n => new Intl.NumberFormat('ru-RU').format(Number(n) || 0) + ' ₽';
const colors = ['#477bb3', '#628fca', '#a57baa', '#b9a04c', '#62a29b', '#8c9bb0'];
const localDate = value => {
  if (!value) return null;
  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const dateField = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());

function rangeFor(period, from, to) {
  const now = new Date();
  const today = startOfDay(now);
  let start = today;
  let end = new Date(today.getTime() + 86400000);
  if (period === 'yesterday') { end = today; start = new Date(today.getTime() - 86400000); }
  if (period === 'week') { start = new Date(today); start.setDate(start.getDate() - (start.getDay() + 6) % 7); end = new Date(start); end.setDate(end.getDate() + 7); }
  if (period === 'month') { start = new Date(today.getFullYear(), today.getMonth(), 1); end = new Date(today.getFullYear(), today.getMonth() + 1, 1); }
  if (period === 'custom') { start = localDate(from) || start; end = localDate(to) || today; end = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1); }
  return [start, end];
}

function Metric({ title, value, change, tone = 'violet', footer, onClick }) {
  const content = <><h3>{title}</h3><strong className={'metric-number ' + tone}>{value}</strong><span className="metric-divider"/><small className={change < 0 ? 'negative' : ''}>{change == null ? ' ' : `${change > 0 ? '+' : ''}${change}`}</small><em>{footer}</em></>;
  return onClick ? <button className="dash-metric" onClick={onClick}>{content}</button> : <article className="dash-metric">{content}</article>;
}

export default function Dashboard({ accountName='OpenCRM', api, onError, deals, tasks, users, currentUser, onDeal, onTasks, onMenu }) {
  const [period, setPeriod] = useState('month');
  const [scope, setScope] = useState('all');
  const [query, setQuery] = useState('');
  const [eventsOpen, setEventsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [from, setFrom] = useState(dateField(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [to, setTo] = useState(dateField(new Date()));
  const [visible, setVisible] = useState(() => {
    try { return JSON.parse(localStorage.getItem('opencrm-dashboard-tiles') || '{}'); } catch { return {}; }
  });
  const [data,setData]=useState({overdue:0,completed:0,todo:0,without:{n:0,amount:0},sources:[],periodDealCount:0,managerRows:[],recent:[],events:[]});
  const show = key => visible[key] !== false;
  const changeVisible = key => setVisible(old => { const next = { ...old, [key]: !show(key) }; localStorage.setItem('opencrm-dashboard-tiles', JSON.stringify(next)); return next; });
  const [start, end] = useMemo(() => rangeFor(period, from, to), [period, from, to]);
  useEffect(()=>{let active=true;const params=new URLSearchParams({from:dateField(start),to:dateField(end),scope,q:query});api('/dashboard?'+params).then(result=>{if(active)setData(result)}).catch(error=>{if(active)onError(error)});return()=>{active=false}},[api,start,end,scope,query,deals,tasks]);
  const sources=data.sources.map(item=>[item.name,item.count]);
  let cursor = 0;
  const arc = sources.map(([, count], i) => { const begin = cursor; cursor += count / Math.max(data.periodDealCount, 1) * 84; return `${colors[i]} ${begin}% ${cursor}%`; }).join(', ');
  const managerRows=data.managerRows;
  const maxManager = Math.max(...managerRows.map(u => u.amount), 1);
  const periodLabel = { today: 'сегодня', yesterday: 'вчера', week: 'за неделю', month: 'за месяц', custom: 'за период' }[period];
  const tileNames = [['overdue', 'Просроченные задачи'], ['done', 'Выполненные задачи'], ['todo', 'Задачи к выполнению'], ['without', 'Сделок без задач'], ['sources', 'Источники сделок'], ['managers', 'Сделки по менеджерам'], ['recent', 'Последние сделки']];

  return <div className="amo-dashboard">
    <div className="dash-top"><button className="dash-mobile-menu" aria-label="Открыть меню" onClick={onMenu}><Menu size={21}/></button><div className="dash-logo">open<span>CRM.</span></div><label className="dash-search"><Search size={18}/><input placeholder="Поиск" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label="Очистить поиск" onClick={() => setQuery('')}><X size={15}/></button>}</label><button className="dash-events" onClick={() => setEventsOpen(!eventsOpen)}><ListFilter size={20}/> СОБЫТИЯ</button></div>
    <div className="dash-center"><h1>{accountName}</h1><div className="dash-controls"><div className="dash-segment" aria-label="Период">{[['today', 'Сегодня'], ['yesterday', 'Вчера'], ['week', 'Неделя'], ['month', 'Месяц'], ['custom', 'Период']].map(([key, label]) => <button key={key} className={period === key ? 'selected' : ''} onClick={() => setPeriod(key)}>{key === 'custom' && <CalendarDays size={14}/>} {label}</button>)}</div><div className="dash-segment scope" aria-label="Ответственные"><button className={scope === 'all' ? 'selected' : ''} onClick={() => setScope('all')}>Все</button><button className={scope === 'mine' ? 'selected' : ''} onClick={() => setScope('mine')}>Мои</button></div><div className="dash-config-wrap"><button className="dash-config" onClick={() => setConfigOpen(!configOpen)}><Settings2 size={17}/> Настроить <ChevronDown size={14}/></button>{configOpen && <div className="dash-config-pop"><b>Показывать плитки</b>{tileNames.map(([key, label]) => <button key={key} onClick={() => changeVisible(key)}><span className={show(key) ? 'dash-check checked' : 'dash-check'}>{show(key) && <Check size={12}/>}</span>{label}</button>)}</div>}</div></div>{period === 'custom' && <div className="dash-dates"><label>С <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)}/></label><label>По <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)}/></label></div>}</div>
    <div className="dash-tiles"><div className="dash-four">
      {show('overdue') && <Metric title="ПРОСРОЧЕННЫЕ ЗАДАЧИ" value={data.overdue} footer="всего" tone="violet" onClick={onTasks}/>}
      {show('done') && <Metric title="ВЫПОЛНЕННЫЕ ЗАДАЧИ" value={data.completed} footer={periodLabel} tone="green" onClick={onTasks}/>}
      {show('todo') && <Metric title="ЗАДАЧИ К ВЫПОЛНЕНИЮ" value={data.todo} footer={periodLabel} tone="violet" onClick={onTasks}/>}
      {show('without') && <Metric title="СДЕЛОК БЕЗ ЗАДАЧ" value={data.without.n} footer={money(data.without.amount)} tone="violet"/>}
    </div>
      {show('sources') && <section className="dash-tile dash-sources"><h2>ИСТОЧНИКИ СДЕЛОК</h2><div className="dash-source-content"><div className="dash-donut" style={{background: sources.length ? `conic-gradient(from 35deg,${arc}, transparent ${cursor}% 100%)` : 'conic-gradient(#315b7c 0% 100%)'}}><span>{data.periodDealCount}<small>сделок</small></span></div><div className="dash-legend">{sources.length ? sources.map(([name, count], i) => <div key={name}><i style={{background: colors[i]}}/><span>{name}</span><b>{count}</b></div>) : <p>Сделок за выбранный период нет</p>}</div></div></section>}
      {show('managers') && <section className="dash-tile dash-managers"><h2>СДЕЛКИ ПО МЕНЕДЖЕРАМ</h2><div className="dash-manager-total"><strong>{managerRows.reduce((n, u) => n + u.count, 0)}</strong><span>{money(managerRows.reduce((n, u) => n + u.amount, 0))}</span></div><div className="dash-manager-list">{managerRows.length ? managerRows.map(u => <div key={u.id} className="dash-manager-row"><span>{u.name} <b>{u.count} сделок</b> <small>({money(u.amount)})</small></span><div><i style={{width: `${Math.max(3, u.amount / maxManager * 100)}%`}}/></div></div>) : <p>Активных сделок нет</p>}</div></section>}
      {show('recent') && <section className="dash-tile dash-recent"><h2>ПОСЛЕДНИЕ СДЕЛКИ</h2>{data.recent.map(d => <button key={d.id} onClick={() => onDeal(d.id)}><span>{d.name}<small>{d.stage_name} · {d.owner_name}</small></span><b>{money(d.amount)}</b></button>)}{!data.recent.length && <p>Сделок не найдено</p>}</section>}
    </div>
    {eventsOpen && <><button className="dash-drawer-scrim" aria-label="Закрыть события" onClick={() => setEventsOpen(false)}/><aside className="dash-events-drawer"><div><h2>СОБЫТИЯ</h2><button aria-label="Закрыть" onClick={() => setEventsOpen(false)}><X size={19}/></button></div><h3>Ближайшие задачи</h3>{data.events.map(t => <button key={t.id} onClick={() => {setEventsOpen(false);onTasks()}}><strong>{t.title}</strong><span>{t.deal_name || t.contact_name || t.company_name || 'Без связи'} · {t.due_at ? localDate(t.due_at)?.toLocaleDateString('ru-RU') : 'Без срока'}</span></button>)}{!data.events.length && <p>Задач нет</p>}</aside></>}
  </div>;
}
