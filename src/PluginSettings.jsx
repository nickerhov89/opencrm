import React, {useEffect, useRef, useState} from 'react';
import {ArrowLeft, Copy, Puzzle, RefreshCw, Search, Trash2, Upload} from 'lucide-react';
import {appPath} from './app-base.js';
import {reloadPlugins} from './plugins.jsx';
import './plugins.css';

const statusLabels = {active: 'Работает', disabled: 'Выключен', stopped: 'Остановлен', error: 'Ошибка запуска', broken: 'Повреждён'};
// A stable hue per plugin so tiles are easy to tell apart without a custom icon.
const hue = id => [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
const kinds = plugin => [plugin.has_server && 'сервер', plugin.has_client && 'интерфейс'].filter(Boolean).join(' · ');

function SettingInput({field, value, secretSet, onChange}) {
  const id = `plugin-setting-${field.key}`;
  if (field.type === 'boolean') return <label className="plugin-check"><input id={id} type="checkbox" checked={!!value} onChange={event => onChange(event.target.checked)}/> {field.label}</label>;
  const control = field.type === 'textarea' ? <textarea id={id} value={value ?? ''} onChange={event => onChange(event.target.value)} rows={4}/>
    : field.type === 'select' ? <select id={id} value={value ?? ''} onChange={event => onChange(event.target.value)}><option value="">—</option>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    : <input id={id} type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'} value={value ?? ''} autoComplete={field.type === 'password' ? 'new-password' : 'off'} data-1p-ignore="" data-lpignore="true" placeholder={field.type === 'password' && secretSet ? 'Сохранено — оставьте пустым, чтобы не менять' : ''} onChange={event => onChange(event.target.value)}/>;
  return <label className="plugin-field" htmlFor={id}><span>{field.label}{field.required && ' *'}</span>{control}</label>;
}

function PluginIcon({plugin, size = 20}) {
  return <div className="plugin-icon" style={{'--plugin-hue': hue(plugin.id)}}><Puzzle size={size}/></div>;
}

function PluginTile({plugin, onOpen}) {
  return <button type="button" className={'plugin-tile ' + plugin.status} onClick={() => onOpen(plugin.id)}>
    <div className="plugin-tile-head"><PluginIcon plugin={plugin}/><span className={'plugin-status ' + plugin.status}>{statusLabels[plugin.status] || plugin.status}</span></div>
    <strong>{plugin.name}</strong>
    <p>{plugin.description || plugin.id}</p>
    <small>{plugin.version}{plugin.author ? ` · ${plugin.author}` : ''}</small>
  </button>;
}

function PluginDetails({plugin, busy, uploadEnabled, onBack, onToggle, onSave, onDelete, onCopy, onUpdate}) {
  const [draft, setDraft] = useState({});
  const fileRef = useRef(null);
  useEffect(() => setDraft({}), [plugin.version, plugin.settings]);
  const values = {...plugin.settings, ...draft};
  const changed = Object.keys(draft).length > 0;
  const save = event => {
    event.preventDefault();
    const body = Object.fromEntries(Object.entries(draft).map(([key, value]) => {
      const field = plugin.settings_schema.find(item => item.key === key);
      return [key, field?.type === 'number' ? (value === '' ? null : Number(value)) : value];
    }));
    onSave(plugin, body);
  };
  const pick = event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onUpdate(plugin, file); };
  return <div className="plugin-details">
    <button type="button" className="plugin-back" onClick={onBack}><ArrowLeft size={15}/> Все плагины</button>
    <section className={'settings-card plugin-card-admin ' + plugin.status}>
      <div className="plugin-head">
        <PluginIcon plugin={plugin} size={24}/>
        <div className="plugin-title"><h3>{plugin.name} <small>{plugin.version}</small></h3><small>{plugin.id}{plugin.author ? ` · ${plugin.author}` : ''}{kinds(plugin) ? ` · ${kinds(plugin)}` : ''}</small></div>
        <span className={'plugin-status ' + plugin.status}>{statusLabels[plugin.status] || plugin.status}</span>
        <label className="plugin-switch" title={plugin.enabled ? 'Выключить' : 'Включить'}><input type="checkbox" aria-label={plugin.enabled ? 'Выключить плагин' : 'Включить плагин'} checked={plugin.enabled} disabled={busy || plugin.status === 'broken'} onChange={() => onToggle(plugin)}/><i/></label>
      </div>
      {plugin.description && <p className="plugin-description">{plugin.description}</p>}
      <div className="plugin-detail-actions">
        {uploadEnabled && <><input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={pick}/><button type="button" className="outline-btn" disabled={busy} onClick={() => fileRef.current?.click()} title="Загрузить новую версию этого плагина (ZIP)"><Upload size={14}/> Обновить</button></>}
        <button type="button" className="outline-btn plugin-delete" disabled={busy} onClick={() => onDelete(plugin)}><Trash2 size={14}/> Удалить</button>
      </div>
      {plugin.error && <pre className="plugin-error">{plugin.error}</pre>}
    </section>
    {plugin.endpoints?.length > 0 && <section className="settings-card"><h4 className="plugin-section-title">Адреса для внешних систем</h4><div className="plugin-endpoints">{plugin.endpoints.map(endpoint => {
      const url = `${window.location.origin}${appPath(endpoint.url)}`;
      return <div key={endpoint.path}><span>{endpoint.label}</span><code>{url}</code><button type="button" onClick={() => onCopy(url)} title="Скопировать"><Copy size={14}/></button></div>;
    })}</div></section>}
    {plugin.settings_schema.length > 0 && <section className="settings-card"><h4 className="plugin-section-title">Настройки</h4><form className="plugin-settings" onSubmit={save}>
      {plugin.settings_schema.map(field => <div key={field.key}><SettingInput field={field} value={values[field.key]} secretSet={plugin.secrets_set?.includes(field.key)} onChange={value => setDraft(current => ({...current, [field.key]: value}))}/>{field.help && <small>{field.help}</small>}</div>)}
      <div className="plugin-actions"><button className="blue-btn" disabled={busy || !changed}>СОХРАНИТЬ</button></div>
    </form></section>}
    <section className="settings-card"><h4 className="plugin-section-title">Журнал</h4>
      <div className="plugin-logs">{plugin.logs.length ? plugin.logs.map((entry, index) => <div key={index} className={entry.level}><time>{new Date(entry.at).toLocaleString('ru-RU')}</time><span>{entry.message}</span></div>) : <p>Записей пока нет.</p>}</div>
    </section>
  </div>;
}

export default function PluginSettings({api, onError}) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState('');
  const fileRef = useRef(null);
  const load = async () => setData(await api('/admin/plugins'));
  useEffect(() => { load().catch(onError); }, []);
  const action = async (work, reload = true) => { setBusy(true); try { await work(); await load(); if (reload) await reloadPlugins(); } catch (error) { onError(error); } finally { setBusy(false); } };
  // The settings column scrolls as a whole: a plugin page starts at the top, «Назад» returns to the same place in the grid.
  const rootRef = useRef(null);
  const listScroll = useRef(0);
  const scroller = () => rootRef.current?.closest('.settings-main');
  useEffect(() => { const element = scroller(); if (element) element.scrollTop = openId ? 0 : listScroll.current; }, [openId]);
  const open = id => { listScroll.current = scroller()?.scrollTop || 0; setOpenId(id); setNotice(''); };
  const back = () => { setOpenId(null); setNotice(''); };
  const send = async (file, expect) => {
    const response = await fetch(appPath(`/api/admin/plugins${expect ? `?expect=${encodeURIComponent(expect)}` : ''}`), {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/zip'}, body: file});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Ошибка ${response.status}`);
    return {result, created: response.status === 201};
  };
  const upload = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void action(async () => {
      const {result, created} = await send(file);
      setOpenId(result.id);
      setNotice(created ? `Плагин «${result.name}» установлен. Проверьте настройки и включите его.` : `Плагин «${result.name}» обновлён до версии ${result.version}.`);
    });
  };
  const update = (plugin, file) => void action(async () => {
    const {result} = await send(file, plugin.id);
    setNotice(result.version === plugin.version ? `«${plugin.name}» переустановлен, версия ${result.version}.` : `«${plugin.name}» обновлён: ${plugin.version} → ${result.version}.`);
  });
  const toggle = plugin => void action(async () => {
    const result = await api(`/admin/plugins/${plugin.id}`, {method: 'PATCH', body: {enabled: !plugin.enabled}});
    setNotice(result.status === 'error' ? '' : result.enabled ? `«${plugin.name}» включён.` : `«${plugin.name}» выключен.`);
  });
  const save = (plugin, settings) => void action(async () => { await api(`/admin/plugins/${plugin.id}`, {method: 'PATCH', body: {settings}}); setNotice(`Настройки «${plugin.name}» сохранены.`); });
  const remove = plugin => { if (window.confirm(`Удалить плагин «${plugin.name}» вместе с его настройками и данными?`)) void action(async () => { await api(`/admin/plugins/${plugin.id}`, {method: 'DELETE'}); setOpenId(null); setNotice(`Плагин «${plugin.name}» удалён.`); }); };
  const copy = async value => { try { await navigator.clipboard.writeText(value); setNotice('Адрес скопирован.'); } catch (error) { onError(error); } };
  const current = openId && data?.plugins.find(plugin => plugin.id === openId);
  const search = query.trim().toLowerCase();
  const shown = data?.plugins.filter(plugin => !search || [plugin.name, plugin.id, plugin.description, plugin.author].some(value => value?.toLowerCase().includes(search))) || [];
  const noticeBox = notice && <div className="plugin-notice" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Закрыть">×</button></div>;
  if (current) return <div className="settings-body plugins-admin" ref={rootRef}>
    {noticeBox}
    <PluginDetails plugin={current} busy={busy} uploadEnabled={data.upload_enabled} onBack={back} onToggle={toggle} onSave={save} onDelete={remove} onCopy={copy} onUpdate={update}/>
  </div>;
  return <div className="settings-body plugins-admin" ref={rootRef}>
    <div className="settings-section-heading">
      <div><h2>Плагины</h2><p>Расширения добавляют в OpenCRM новые разделы, блоки в карточке сделки и приём данных из внешних сервисов.</p></div>
      <div className="plugin-toolbar">
        <button type="button" className="outline-btn" disabled={busy} onClick={() => action(load, false)} title="Обновить список"><RefreshCw size={15}/></button>
        {data?.upload_enabled && <><input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={upload}/><button type="button" className="blue-btn" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={15}/> ЗАГРУЗИТЬ ПЛАГИН</button></>}
      </div>
    </div>
    <div className="integrations-note">Плагин — это код, который работает внутри CRM с доступом ко всем данным. Устанавливайте только плагины из надёжных источников. Формат пакета и API для разработчиков описаны в docs/PLUGINS.md.{data && !data.upload_enabled && ' Загрузка через интерфейс выключена: устанавливайте плагины на сервере командой npm run plugin -- install <файл.zip>.'}</div>
    {noticeBox}
    {!data ? <p className="settings-no-results">Загрузка…</p>
      : data.plugins.length ? <>
        {data.plugins.length > 6 && <label className="plugin-search"><Search size={15}/><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти плагин" aria-label="Найти плагин"/></label>}
        {shown.length ? <div className="plugin-grid">{shown.map(plugin => <PluginTile key={plugin.id} plugin={plugin} onOpen={open}/>)}</div> : <p className="settings-no-results">Ничего не найдено.</p>}
      </>
      : <section className="settings-card"><p className="settings-no-results">Плагинов пока нет. Загрузите ZIP-архив плагина или положите папку плагина в каталог плагинов на сервере.</p></section>}
  </div>;
}
