import React, {useEffect, useState} from 'react';
import {ChevronLeft, ChevronRight, Download, Play, Settings2} from 'lucide-react';
import './analytics-reports.css';
import {appPath} from './app-base.js';

const num = n => new Intl.NumberFormat('ru-RU').format(Number(n) || 0);
const money = n => `${num(n)} ₽`;
const length = seconds => {
  const s = Math.max(0, Math.round(Number(seconds) || 0)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, rest = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};
const short = seconds => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return s >= 3600 ? length(s) : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const when = value => new Date(`${String(value).replace(' ', 'T')}Z`).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'});
const monthName = month => new Date(`${month}-15T12:00:00`).toLocaleDateString('ru-RU', {month: 'long', year: 'numeric'});
const shiftMonth = (month, by) => { const date = new Date(`${month}-15T12:00:00`); date.setMonth(date.getMonth() + by); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; };
const thisMonth = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; };

async function load(path, options = {}) {
  const response = await fetch(appPath(path), {...options, headers: {'Content-Type': 'application/json', ...(options.headers || {})}});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Ошибка отчёта');
  return body;
}

// Analytics → Звонки: incoming and outgoing calls of each employee, and the latest calls.
export function CallsReport({from, to, revision, onDeal, onEntity}) {
  const [report, setReport] = useState(null), [error, setError] = useState(''), [basis, setBasis] = useState('count'), [direction, setDirection] = useState(''), [playing, setPlaying] = useState('');
  useEffect(() => {
    let alive = true;
    setError('');
    load(`/api/reports/calls?from=${from}&to=${to}${direction ? `&direction=${direction}` : ''}`).then(body => { if (alive) setReport(body); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [from, to, direction, revision]);
  if (error) return <div className="analytics-error" role="alert">{error}</div>;
  if (!report) return <div className="analytics-loading">Загружаем отчет…</div>;
  const value = row => basis === 'count' ? row.incoming + row.outgoing : row.seconds;
  const rows = [...report.people.map(person => ({...person, kind: 'person'})), {name: 'Среднее количество', ...report.average, kind: 'average'}, {name: 'Итого', ...report.total, kind: 'total'}];
  const max = Math.max(1, ...rows.map(value));
  const open = target => { if (target.kind === 'deal') onDeal(target.id); else if (target.kind === 'contact' || target.kind === 'company') onEntity(target.kind, target.id); };
  return <>
    <div className="analytics-section-heading"><h2>ЗВОНКИ</h2><span>Входящие и исходящие звонки сотрудников за период: из amoCRM, записанные в сделках и из Mango Office</span></div>
    <section className="analytics-white calls-chart">
      <div className="analytics-tabs"><div><span className="calls-legend"><i className="in"/>Входящие <i className="out"/>Исходящие</span></div><div>{[['count', 'По количеству'], ['seconds', 'По длительности']].map(([key, label]) => <button key={key} className={basis === key ? 'active' : ''} onClick={() => setBasis(key)}>{label}</button>)}</div></div>
      {report.people.length === 0 && <div className="analytics-empty">Звонков за период нет</div>}
      {report.people.length > 0 && rows.map(row => {
        const total = row.incoming + row.outgoing, width = 100 * value(row) / max, share = total ? 100 * row.incoming / total : 0;
        return <div className={`calls-row ${row.kind}`} key={`${row.kind}:${row.user_id ?? row.name}`}>
          <div className="calls-name"><strong>{row.name}</strong>{row.kind === 'person' && <small>Продолжительность: {length(row.seconds)}</small>}</div>
          <div className="calls-bar"><div style={{width: `${Math.max(width, value(row) ? 1.5 : 0)}%`}} title={`Входящих: ${row.incoming}, исходящих: ${row.outgoing}, ${length(row.seconds)}`}>{basis === 'count' ? <><i className="in" style={{width: `${share}%`}}/><i className="out" style={{width: `${100 - share}%`}}/></> : <i className="time" style={{width: '100%'}}/>}</div><b>{basis === 'count' ? num(total) : length(row.seconds)}</b>{basis === 'count' && total > 0 && <small>{num(row.incoming)} / {num(row.outgoing)}</small>}</div>
        </div>;
      })}
    </section>
    <div className="analytics-section-heading second"><h2>НЕДАВНИЕ ЗВОНКИ</h2><div className="analytics-tabs calls-filter">{[['', 'Все'], ['incoming', 'Входящие'], ['outgoing', 'Исходящие']].map(([key, label]) => <button key={key} className={direction === key ? 'active' : ''} onClick={() => setDirection(key)}>{label}</button>)}</div></div>
    <section className="analytics-white calls-table">
      <div className="calls-head"><span>ДАТА ЗВОНКА</span><span>СОБЫТИЕ</span><span>РЕЗУЛЬТАТ</span><span>ДЛИТ.</span></div>
      {report.recent.map(call => <div className="calls-line" key={call.key}>
        <time>{when(call.at)}</time>
        <span>{call.user_name || (call.direction === 'incoming' ? 'Входящий' : 'Исходящий')} {call.direction === 'incoming' ? '←' : '→'} {['deal', 'contact', 'company'].includes(call.target.kind) ? <button onClick={() => open(call.target)}>{call.target.name}</button> : <em>{call.target.name || 'Неизвестный номер'}</em>}</span>
        <span className="calls-result">{call.result || (call.direction === 'incoming' ? 'входящий' : 'исходящий')}{call.recording && (call.recording.startsWith('/') ? <button className="calls-play" title="Прослушать" onClick={() => setPlaying(playing === call.key ? '' : call.key)}><Play size={13}/></button> : <a className="calls-play" href={call.recording} target="_blank" rel="noreferrer" title="Запись разговора"><Download size={13}/></a>)}{playing === call.key && <audio src={appPath(call.recording)} controls autoPlay/>}</span>
        <span>{call.seconds ? short(call.seconds) : '—'}</span>
      </div>)}
      {report.recent.length === 0 && <div className="analytics-empty">Звонков за период нет</div>}
    </section>
  </>;
}

// Analytics → Цели: a goal for the month per employee (budget and number of won deals) and progress.
export function GoalsReport({isAdmin}) {
  const [month, setMonth] = useState(thisMonth()), [report, setReport] = useState(null), [error, setError] = useState(''), [basis, setBasis] = useState('amount'), [draft, setDraft] = useState(null), [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setError(''); setDraft(null);
    load(`/api/reports/goals?month=${month}`).then(body => { if (alive) setReport(body); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [month]);
  const save = async event => {
    event.preventDefault(); setSaving(true); setError('');
    try {
      setReport(await load('/api/reports/goals', {method: 'PUT', body: JSON.stringify({month, goals: draft.map(item => ({user_id: item.user_id, amount: Number(String(item.amount).replace(/\s/g, '')) || 0, deals: Number(item.deals) || 0}))})}));
      setDraft(null);
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };
  const goal = row => basis === 'amount' ? row.goal_amount : row.goal_deals, done = row => basis === 'amount' ? row.won_amount : row.won_deals;
  const format = basis === 'amount' ? money : num;
  const rows = report ? [{name: 'Всего', ...report.total, kind: 'total'}, ...report.people.map(person => ({...person, kind: 'person'}))] : [];
  const max = Math.max(1, ...rows.map(row => Math.max(goal(row), done(row))));
  return <>
    <div className="analytics-section-heading goals-heading"><h2>ЦЕЛИ ПО СДЕЛКАМ</h2><div className="goals-month"><button title="Предыдущий месяц" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={16}/></button><span>{monthName(month)}</span><button title="Следующий месяц" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={16}/></button></div>{isAdmin && report && !draft && <button className="goals-settings" onClick={() => setDraft(report.people.map(person => ({user_id: person.user_id, name: person.name, amount: person.goal_amount || '', deals: person.goal_deals || ''})))}><Settings2 size={15}/> Настройки целей</button>}</div>
    {error && <div className="analytics-error" role="alert">{error}</div>}
    {!report && !error && <div className="analytics-loading">Загружаем отчет…</div>}
    {draft && <section className="analytics-white goals-form"><p>Цель на {monthName(month)}: бюджет и количество успешных сделок, закрытых сотрудником в этом месяце. Пустое поле — без цели.</p>
      <form onSubmit={save}><div className="goals-form-head"><span>СОТРУДНИК</span><span>БЮДЖЕТ, ₽</span><span>СДЕЛОК</span></div>
        {draft.map((item, index) => <div className="goals-form-row" key={item.user_id}><strong>{item.name}</strong><input inputMode="numeric" aria-label={`Бюджет: ${item.name}`} value={item.amount} onChange={event => setDraft(old => old.map((row, i) => i === index ? {...row, amount: event.target.value.replace(/[^\d\s]/g, '')} : row))} placeholder="Бюджет"/><input inputMode="numeric" aria-label={`Сделок: ${item.name}`} value={item.deals} onChange={event => setDraft(old => old.map((row, i) => i === index ? {...row, deals: event.target.value.replace(/\D/g, '')} : row))} placeholder="Количество"/></div>)}
        <div className="goals-form-actions"><button type="button" onClick={() => setDraft(null)}>Отмена</button><button className="blue-btn" disabled={saving}>{saving ? 'СОХРАНЯЕМ…' : 'СОХРАНИТЬ'}</button></div></form></section>}
    {report && !draft && <section className="analytics-white goals-chart">
      <div className="analytics-tabs"><div><span className="calls-legend"><i className="done"/>Выполнено <i className="goal"/>Цель</span></div><div>{[['amount', 'По бюджету'], ['deals', 'По количеству']].map(([key, label]) => <button key={key} className={basis === key ? 'active' : ''} onClick={() => setBasis(key)}>{label}</button>)}</div></div>
      {report.total.goal_amount === 0 && report.total.goal_deals === 0 && <div className="goals-hint">Цели на {monthName(month)} не заданы.{isAdmin ? ' Задайте их в «Настройках целей».' : ''} Ниже — успешные сделки сотрудников за месяц.</div>}
      {rows.map(row => {
        const target = goal(row), value = done(row), percent = target ? Math.round(100 * value / target) : null;
        return <div className={`goals-row ${row.kind}${target && value < target ? ' behind' : ''}`} key={`${row.kind}:${row.user_id ?? 'total'}`}>
          <strong>{row.name}</strong>
          <div className="goals-bar"><div className="goals-track">{target > 0 && <i className="goal" style={{width: `${100 * target / max}%`}}/>}<i className="done" style={{width: `${Math.max(value ? 1 : 0, 100 * value / max)}%`}}/></div><span>{format(value)}{target > 0 && <> из {format(target)} · <b>{percent}%</b></>}</span></div>
        </div>;
      })}
    </section>}
  </>;
}
