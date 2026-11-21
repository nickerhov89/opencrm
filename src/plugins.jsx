import React, {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Puzzle, Sparkles, Phone, MessageCircle, Mail, FileText, BarChart3, Plug, Star, Bell, Globe} from 'lucide-react';
import {appPath} from './app-base.js';
import './plugins.css';

// Browser side of plugins: loads each enabled plugin's module after sign-in and keeps what it
// registered (pages in the left menu, panels in the deal card). See docs/PLUGINS.md.

const icons = {puzzle: Puzzle, sparkles: Sparkles, phone: Phone, message: MessageCircle, mail: Mail, form: FileText, chart: BarChart3, plug: Plug, star: Star, bell: Bell, globe: Globe};
let state = {loaded: false, pages: [], dealPanels: [], errors: []};
const listeners = new Set();
const update = change => { state = {...state, ...change(state)}; listeners.forEach(listener => listener()); };
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
const usePlugins = () => useSyncExternalStore(subscribe, () => state);
const slotId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(value) ? value : null;

async function request(path, options = {}) {
  const body = options.body !== undefined && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body;
  const response = await fetch(appPath(path), {credentials: 'same-origin', ...options, headers: {'Content-Type': 'application/json', ...options.headers}, body});
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) { const error = new Error(data?.error || `Ошибка ${response.status}`); error.status = response.status; error.data = data; throw error; }
  return data;
}

let loading = null, lastOptions = null;
// After a plugin is switched on, off or updated in the settings: forget what plugins registered
// and load their browser modules again.
export function reloadPlugins() {
  if (!lastOptions) return Promise.resolve();
  loading = null;
  update(() => ({loaded: false, pages: [], dealPanels: [], errors: []}));
  return loadPlugins(lastOptions);
}
export function loadPlugins(options) {
  const {user, notify, openDeal} = options;
  lastOptions = options;
  if (loading) return loading;
  loading = (async () => {
    let list = [];
    try { list = await request('/api/plugins'); } catch (error) { update(() => ({loaded: true, errors: [String(error.message)]})); return; }
    for (const plugin of list) {
      const add = key => item => {
        const id = slotId(item?.id);
        if (!id || (typeof item.render !== 'function' && typeof item.mount !== 'function')) throw new Error(`Плагин ${plugin.id}: у элемента нужен id и render или mount`);
        update(current => ({[key]: [...current[key].filter(entry => entry.key !== `${plugin.id}/${id}`), {...item, id, key: `${plugin.id}/${id}`, plugin: plugin.id, pluginName: plugin.name}]}));
      };
      const api = {
        id: plugin.id, name: plugin.name, version: plugin.version, settings: plugin.settings || {}, user,
        React, h: React.createElement, useState, useEffect, useMemo, useRef,
        fetch: (path, options) => request(`/api/plugins/${plugin.id}${path.startsWith('/') ? path : `/${path}`}`, options),
        api: (path, options) => request(`/api${path.startsWith('/') ? path : `/${path}`}`, options),
        notify: message => notify?.(String(message)),
        openDeal: id => openDeal?.(Number(id)),
        addPage: add('pages'),
        addDealPanel: add('dealPanels'),
      };
      try {
        const module = await import(/* @vite-ignore */ appPath(plugin.client));
        const start = module.activate || module.default;
        if (typeof start !== 'function') throw new Error('модуль должен экспортировать функцию activate(api)');
        await start(api);
      } catch (error) {
        console.error(`Plugin ${plugin.id}:`, error);
        update(current => ({errors: [...current.errors, `${plugin.name}: ${error.message}`]}));
      }
    }
    update(() => ({loaded: true}));
  })();
  return loading;
}

export const pluginView = page => `plugin:${page.key}`;

// Shows a plugin's render(props) inside the app, or lets it draw into a DOM node with mount(el, props).
function Slot({item, props}) {
  const ref = useRef(null);
  const mountRef = useRef(null);
  useEffect(() => {
    if (!item.mount || !ref.current) return;
    let result;
    try { result = item.mount(ref.current, props); } catch (error) { console.error(error); }
    mountRef.current = result;
    return () => { try { typeof result === 'function' ? result() : result?.unmount?.(); } catch (error) { console.error(error); } if (ref.current) ref.current.replaceChildren(); };
  }, [item.key]);
  useEffect(() => { mountRef.current?.update?.(props); }, [props]);
  if (item.mount) return <div ref={ref}/>;
  return <SlotBoundary name={item.pluginName}><item.render {...props}/></SlotBoundary>;
}

class SlotBoundary extends React.Component {
  constructor(props) { super(props); this.state = {error: null}; }
  static getDerivedStateFromError(error) { return {error}; }
  componentDidCatch(error) { console.error(`Plugin ${this.props.name}:`, error); }
  render() { return this.state.error ? <p className="plugin-error">Плагин «{this.props.name}» не смог показать блок: {String(this.state.error.message)}</p> : this.props.children; }
}

export function PluginNav({view, onOpen, auth, notify, openDeal}) {
  const {pages} = usePlugins();
  useEffect(() => { if (auth) void loadPlugins({user: auth, notify, openDeal}); }, [auth?.id]);
  return pages.map(page => {
    const Icon = icons[page.icon] || Puzzle;
    return <button key={page.key} className={'nav-item ' + (view === pluginView(page) ? 'active' : '')} onClick={() => onOpen(pluginView(page))} title={page.label}><Icon size={24} strokeWidth={1.45}/><span>{String(page.label || page.pluginName).slice(0, 24)}</span></button>;
  });
}

export function PluginPage({view, auth, onMenu}) {
  const {pages, loaded} = usePlugins();
  const page = pages.find(item => pluginView(item) === view);
  const props = useMemo(() => ({user: auth}), [auth]);
  if (!page) return <div className="plugin-page"><p className="plugin-muted">{loaded ? 'Страница плагина не найдена: плагин выключен или удалён.' : 'Загрузка…'}</p></div>;
  return <div className="plugin-page">
    <header className="plugin-page-head"><button className="hamburger" onClick={onMenu} aria-label="Открыть меню">☰</button><h1>{page.title || page.label}</h1><span>{page.pluginName}</span></header>
    <Slot item={page} props={props}/>
  </div>;
}

export function DealPluginPanels({deal}) {
  const {dealPanels} = usePlugins();
  const props = useMemo(() => ({deal}), [deal]);
  if (!dealPanels.length) return null;
  return <div className="plugin-deal-panels">{dealPanels.map(panel => <section className="plugin-deal-panel" key={panel.key}><h3>{panel.title || panel.pluginName}</h3><Slot item={panel} props={props}/></section>)}</div>;
}
