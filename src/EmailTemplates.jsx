import React, {useEffect, useState} from 'react';
import {Pencil, Plus, Trash2} from 'lucide-react';

const blank = {name: '', subject: '', body: ''};

// Settings → Почта → Шаблоны писем: ready subjects and texts for «Новое письмо» and the deal letter.
export default function EmailTemplates({api, onError}) {
  const [items, setItems] = useState([]), [form, setForm] = useState(null), [busy, setBusy] = useState(false);
  const load = async () => setItems(await api('/mail/templates'));
  useEffect(() => { load().catch(onError); }, []);
  const set = (key, value) => setForm(old => ({...old, [key]: value}));
  const run = async work => { setBusy(true); try { await work(); await load(); return true; } catch (error) { onError(error); return false; } finally { setBusy(false); } };
  const save = event => { event.preventDefault(); void run(async () => { await api(form.id ? `/mail/templates/${form.id}` : '/mail/templates', {method: form.id ? 'PATCH' : 'POST', body: {name: form.name, subject: form.subject, body: form.body}}); setForm(null); }); };
  return <section className="settings-card integrations-card"><div className="settings-card-title"><div><h2>Шаблоны писем</h2><p>Сотрудники выбирают шаблон в «Новом письме» и в письме из сделки: он подставляет тему и текст.</p></div>{!form && <button className="blue-btn" onClick={() => setForm({...blank})}><Plus size={15}/> ШАБЛОН</button>}</div>
    {form && <form onSubmit={save} className="integrations-form mail-form">
      <label>Название<input value={form.name} maxLength={120} onChange={event => set('name', event.target.value)} placeholder="Например, Коммерческое предложение" required/></label>
      <label>Тема<input value={form.subject} maxLength={500} onChange={event => set('subject', event.target.value)}/></label>
      <label>Текст<textarea rows={8} value={form.body} maxLength={50000} onChange={event => set('body', event.target.value)}/></label>
      <div className="mail-box-actions"><button type="button" onClick={() => setForm(null)}>Отмена</button><button className="blue-btn" disabled={busy || !form.name.trim() || !form.subject.trim() && !form.body.trim()}>{busy ? 'СОХРАНЯЕМ…' : 'СОХРАНИТЬ'}</button></div>
    </form>}
    <div className="integrations-list">{items.map(item => <div className="integrations-row mail-box-row" key={item.id}><div><strong>{item.name}</strong><small>{item.subject || 'Без темы'}{item.body ? ` · ${item.body.replace(/\s+/g, ' ').slice(0, 120)}` : ''}</small></div>
      <div className="mail-box-actions"><button type="button" disabled={busy} onClick={() => setForm({id: item.id, name: item.name, subject: item.subject, body: item.body})}><Pencil size={15}/> Изменить</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(`Удалить шаблон «${item.name}»?`)) void run(() => api(`/mail/templates/${item.id}`, {method: 'DELETE'})); }}><Trash2 size={15}/> Удалить</button></div></div>)}
      {items.length === 0 && !form && <div className="empty">Шаблонов пока нет.</div>}</div>
  </section>;
}
