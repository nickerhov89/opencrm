import React, {useEffect, useRef, useState} from 'react';
import {Copy, Puzzle, RefreshCw, Trash2, Upload} from 'lucide-react';
import {appPath} from './app-base.js';
import './plugins.css';

const statusLabels = {active: 'Работает', disabled: 'Выключен', stopped: 'Остановлен', error: 'Ошибка запуска', broken: 'Повреждён'};

function SettingInput({field, value, secretSet, onChange}) {
  const id = `plugin-setting-${field.key}`;
  if (field.type === 'boolean') return <label className="plugin-check"><input id={id} type="checkbox" checked={!!value} onChange={event => onChange(event.target.checked)}/> {field.label}</label>;
  const control = field.type === 'textarea' ? <textarea id={id} value={value ?? ''} onChange={event => onChange(event.target.value)} rows={4}/>
    : field.type === 'select' ? <select id={id} value={value ?? ''} onChange={event => onChange(event.target.value)}><option value="">—</option>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    : <input id={id} type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'} value={value ?? ''} autoComplete="off" placeholder={field.type === 'password' && secretSet ? 'Сохранено — оставьте пустым, чтобы не менять' : ''} onChange={event => onChange(event.target.value)}/>;
  return <label className="plugin-field" htmlFor={id}><span>{field.label}{field.required && ' *'}</span>{control}</label>;
}

function PluginCard({plugin, busy, onToggle, onSave, onDelete, onCopy}) {
  const [draft, setDraft] = useState({});
  const [logsOpen, setLogsOpen] = useState(false);
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
  return <section className={'settings-card plugin-card-admin ' + plugin.status}>
    <div className="plugin-head">
      <div className="plugin-icon"><Puzzle size={20}/></div>
      <div className="plugin-title"><h3>{plugin.name} <small>{plugin.version}</small></h3><p>{plugin.description || plugin.id}</p><small>{plugin.id}{plugin.author ? ` · ${plugin.author}` : ''}{plugin.has_server ? ' · сервер' : ''}{plugin.has_client ? ' · интерфейс' : ''}</small></div>
      <span className={'plugin-status ' + plugin.status}>{statusLabels[plugin.status] || plugin.status}</span>
      <label className="plugin-switch" title={plugin.enabled ? 'Выключить' : 'Включить'}><input type="checkbox" checked={plugin.enabled} disabled={busy || plugin.status === 'broken'} onChange={() => onToggle(plugin)}/><i/></label>
    </div>
    {plugin.error && <pre className="plugin-error">{plugin.error}</pre>}
    {plugin.endpoints?.length > 0 && <div className="plugin-endpoints">{plugin.endpoints.map(endpoint => {
      const url = `${window.location.origin}${appPath(endpoint.url)}`;
      return <div key={endpoint.path}><span>{endpoint.label}</span><code>{url}</code><button type="button" onClick={() => onCopy(url)} title="Скопировать"><Copy size={14}/></button></div>;
    })}</div>}
    {plugin.settings_schema.length > 0 && <form className="plugin-settings" onSubmit={save}>
      {plugin.settings_schema.map(field => <div key={field.key}><SettingInput field={field} value={values[field.key]} secretSet={plugin.secrets_set?.includes(field.key)} onChange={value => setDraft(current => ({...current, [field.key]: value}))}/>{field.help && <small>{field.help}</small>}</div>)}
      <div className="plugin-actions"><button className="blue-btn" disabled={busy || !changed}>СОХРАНИТЬ</button></div>
    </form>}
    <div className="plugin-footer">
      <button type="button" onClick={() => setLogsOpen(!logsOpen)}>{logsOpen ? 'Скрыть журнал' : `Журнал (${plugin.logs.length})`}</button>
      <button type="button" className="plugin-delete" disabled={busy} onClick={() => onDelete(plugin)}><Trash2 size={14}/> Удалить</button>
    </div>
    {logsOpen && <div className="plugin-logs">{plugin.logs.length ? plugin.logs.map((entry, index) => <div key={index} className={entry.level}><time>{new Date(entry.at).toLocaleString('ru-RU')}</time><span>{entry.message}</span></div>) : <p>Записей пока нет.</p>}</div>}
  </section>;
}

export default function PluginSettings({api, onError}) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);
  const load = async () => setData(await api('/admin/plugins'));
  useEffect(() => { load().catch(onError); }, []);
  const action = async work => { setBusy(true); try { await work(); await load(); } catch (error) { onError(error); } finally { setBusy(false); } };
  const upload = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void action(async () => {
      const response = await fetch(appPath('/api/admin/plugins'), {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/zip'}, body: file});
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Ошибка ${response.status}`);
      setNotice(response.status === 201 ? `Плагин «${result.name}» установлен. Проверьте настройки и включите его.` : `Плагин «${result.name}» обновлён до версии ${result.version}.`);
    });
  };
  const toggle = plugin => void action(async () => {
    const result = await api(`/admin/plugins/${plugin.id}`, {method: 'PATCH', body: {enabled: !plugin.enabled}});
    setNotice(result.status === 'error' ? '' : result.enabled ? `«${plugin.name}» включён. Обновите страницу, чтобы появились его разделы.` : `«${plugin.name}» выключен.`);
  });
  const save = (plugin, settings) => void action(async () => { await api(`/admin/plugins/${plugin.id}`, {method: 'PATCH', body: {settings}}); setNotice(`Настройки «${plugin.name}» сохранены.`); });
  const remove = plugin => { if (window.confirm(`Удалить плагин «${plugin.name}» вместе с его настройками и данными?`)) void action(async () => { await api(`/admin/plugins/${plugin.id}`, {method: 'DELETE'}); setNotice(`Плагин «${plugin.name}» удалён.`); }); };
  const copy = async value => { try { await navigator.clipboard.writeText(value); setNotice('Адрес скопирован.'); } catch (error) { onError(error); } };
  return <div className="settings-body plugins-admin">
    <div className="settings-section-heading">
      <div><h2>Плагины</h2><p>Расширения добавляют в OpenCRM новые разделы, блоки в карточке сделки и приём данных из внешних сервисов.</p></div>
      <div className="plugin-toolbar">
        <button type="button" className="outline-btn" disabled={busy} onClick={() => action(load)} title="Обновить список"><RefreshCw size={15}/></button>
        {data?.upload_enabled && <><input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={upload}/><button type="button" className="blue-btn" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={15}/> ЗАГРУЗИТЬ ПЛАГИН</button></>}
      </div>
    </div>
    <div className="integrations-note">Плагин — это код, который работает внутри CRM с доступом ко всем данным. Устанавливайте только плагины из надёжных источников. Формат пакета и API для разработчиков описаны в docs/PLUGINS.md.{data && !data.upload_enabled && ' Загрузка через интерфейс выключена: устанавливайте плагины на сервере командой npm run plugin -- install <файл.zip>.'}</div>
    {notice && <div className="plugin-notice" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Закрыть">×</button></div>}
    {!data ? <p className="settings-no-results">Загрузка…</p>
      : data.plugins.length ? data.plugins.map(plugin => <PluginCard key={plugin.id} plugin={plugin} busy={busy} onToggle={toggle} onSave={save} onDelete={remove} onCopy={copy}/>)
      : <section className="settings-card"><p className="settings-no-results">Плагинов пока нет. Загрузите ZIP-архив плагина или положите папку плагина в каталог плагинов на сервере.</p></section>}
  </div>;
}
