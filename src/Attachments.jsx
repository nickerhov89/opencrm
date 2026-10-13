import React, { useRef, useState } from 'react';
import { Download, FileText, Paperclip, Plus } from 'lucide-react';
import './attachments.css';
import {appPath} from './app-base.js';

const size = bytes => bytes < 1024 ? `${bytes} Б` : bytes < 1048576 ? `${Math.round(bytes / 1024)} КБ` : `${(bytes / 1048576).toFixed(1)} МБ`;

export default function Attachments({ entityType, entityId, items = [], onUploaded, onError }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const upload = async event => {
    const files = [...(event.target.files || [])];
    if (!files.length) return;
    setBusy(true);
    try {
      for (const file of files) {
        if (!file.size || file.size > 15 * 1024 * 1024) throw new Error('Файл должен быть непустым и не больше 15 МБ');
        const response = await fetch(appPath(`/api/attachments/${entityType}/${entityId}`), {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','x-file-name':encodeURIComponent(file.name),'x-file-type':file.type || 'application/octet-stream'},body:file});
        if (!response.ok) throw new Error((await response.json().catch(()=>({}))).error || `Ошибка ${response.status}`);
      }
      await onUploaded();
    } catch(error) { onError(error); }
    finally { event.target.value=''; setBusy(false); }
  };
  return <div className="attachments"><div className="attachments-head"><span><Paperclip size={16}/> Файлы · {items.length}</span><input ref={input} type="file" multiple hidden onChange={upload}/><button className="blue-btn" disabled={busy} onClick={()=>input.current?.click()}><Plus size={15}/>{busy?'Загрузка…':'ПРИКРЕПИТЬ ФАЙЛ'}</button></div>{items.length ? <div className="attachments-list">{items.map(file=><a className="attachment-item" key={file.id} href={appPath(`/api/attachments/${file.id}/download`)} download={file.filename}><span className="attachment-icon"><FileText size={21}/></span><span className="attachment-meta"><strong>{file.filename}</strong><small>{size(file.byte_size)} · {file.author || 'Система'}</small></span><Download size={17}/></a>)}</div> : <div className="attachments-empty"><Paperclip size={32}/><strong>Файлов пока нет</strong><span>Прикрепите документ, изображение или другой файл к этой записи.</span></div>}</div>;
}
