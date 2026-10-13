import React, { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import CustomValueInput from './CustomValueInput.jsx';
import './custom-fields.css';

export default function CustomFields({ fields = [], onSave }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEditing(null); setDraft(''); }, [fields[0]?.entity_type, fields[0]?.id]);
  async function save(field) {
    setBusy(true);
    const ok = await onSave(field, draft);
    setBusy(false);
    if (ok) setEditing(null);
  }
  return <div className="custom-fields">{fields.map(field => <div className="field-row custom-field-row" key={field.id}><span>{field.name}</span>{editing === field.id ? <div className="custom-editor"><CustomValueInput field={field} value={draft} autoFocus onChange={setDraft} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); save(field); } if (event.key === 'Escape') setEditing(null); }}/><button title="Сохранить" disabled={busy} onClick={() => save(field)}><Check size={15}/></button><button title="Отмена" onClick={() => setEditing(null)}><X size={15}/></button></div> : <button className="custom-field-value" title="Изменить поле" onClick={() => { setDraft(field.value || ''); setEditing(field.id); }}>{field.value || '···'}</button>}</div>)}</div>;
}
