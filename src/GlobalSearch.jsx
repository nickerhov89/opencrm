import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Building2, KanbanSquare, Search, UserRound, X} from 'lucide-react';
import './global-search.css';

const emptyResults = {deals: [], contacts: [], companies: []};
const groups = [
  ['deals', 'Сделки', KanbanSquare],
  ['contacts', 'Контакты', UserRound],
  ['companies', 'Компании', Building2],
];

export default function GlobalSearch({api, initialQuery = '', section = null, anchor, onSectionSearch, onClose, onOpenDeal, onOpenEntity, onError}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState(emptyResults);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(section ? -1 : 0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const q = query.trim();
    setResults(emptyResults);
    setActive(section ? -1 : 0);
    if (q.length < 2) { setLoading(false); return; }
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api('/search?q=' + encodeURIComponent(q))
        .then(data => { if (live) setResults(data); })
        .catch(error => { if (live) onError(error); })
        .finally(() => { if (live) setLoading(false); });
    }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [query, section]);

  const items = useMemo(() => [
    ...results.deals.map(item => ({kind: 'deal', ...item})),
    ...results.contacts.map(item => ({kind: 'contact', ...item})),
    ...results.companies.map(item => ({kind: 'company', ...item})),
  ], [results]);
  const open = item => {
    onClose();
    if (item.kind === 'deal') onOpenDeal(item.id);
    else onOpenEntity(item.kind, item.id);
  };
  const openInNewTab = item => {
    const path = item.kind === 'deal' ? `/deals/${item.id}` : `/${item.kind === 'contact' ? 'contacts' : 'companies'}/${item.id}`;
    window.open(path, '_blank', 'noopener');
    onClose();
  };
  const onKeyDown = event => {
    if (event.key === 'Escape') onClose();
    else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(index => Math.min(index + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => Math.max(index - 1, section ? -1 : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0 && items[active]) (event.ctrlKey || event.metaKey ? openInNewTab : open)(items[active]);
      else if (section) onSectionSearch(query);
    }
  };

  let offset = 0;
  return <>
    <button className={'global-search-scrim'+(anchor?' inline':'')} aria-label="Закрыть общий поиск" onPointerDown={onClose}/>
    <section className={'global-search-panel'+(anchor?' inline':'')} style={anchor?{'--search-left':anchor.left+'px','--search-top':anchor.top+'px','--search-width':anchor.width+'px'}:undefined} role="dialog" aria-modal="true" aria-label="Общий поиск">
      <header>
        <Search size={20}/>
        <input ref={inputRef} aria-label="Поиск по CRM" placeholder="Найти сделку, контакт или компанию" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown}/>
        <button aria-label="Закрыть" onClick={onClose}><X size={18}/></button>
      </header>
      <div className="global-search-results">
        {query.trim().length < 2
          ? <p className="global-search-hint">Введите минимум два символа. Поиск работает по названиям, контактным данным и связанным сделкам.</p>
          : loading
            ? <p className="global-search-hint">Ищем…</p>
            : items.length === 0
              ? <p className="global-search-hint">Ничего не найдено</p>
              : groups.map(([key, title, Icon]) => {
                const group = results[key];
                const start = offset;
                offset += group.length;
                if (!group.length) return null;
                return <div className="global-search-group" key={key}>
                  <h3>{title} <span>{group.length}</span></h3>
                  {group.map((item, index) => {
                    const position = start + index;
                    return <button className={active === position ? 'selected' : ''} key={key + item.id} onMouseEnter={() => setActive(position)} onClick={() => open({...item, kind: key === 'deals' ? 'deal' : key === 'contacts' ? 'contact' : 'company'})}>
                      <Icon size={17}/>
                      <span><strong>{item.name}</strong><small>{key === 'deals' ? [item.contact_name || item.company_name, item.pipeline_name, item.stage_name].filter(Boolean).join(' · ') : key === 'contacts' ? [item.company_name, item.position, item.phone || item.email].filter(Boolean).join(' · ') : item.phone || item.email || item.website || 'Компания'}</small></span>
                      {key === 'deals' && <em>{new Intl.NumberFormat('ru-RU').format(item.amount || 0)} ₽</em>}
                    </button>;
                  })}
                </div>;
              })}
      </div>
      <footer>↑ ↓ выбрать <span>{section ? 'Enter искать в разделе' : 'Enter открыть'}</span><span>⌘/Ctrl+Enter новая вкладка</span><span>Esc закрыть</span></footer>
    </section>
  </>;
}
