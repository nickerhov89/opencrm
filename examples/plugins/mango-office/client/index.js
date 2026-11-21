// Calls in the deal card (with the recording player) and the «Звонки» journal in the left menu.
export default function activate(api) {
  const {h, useState, useEffect} = api;
  const time = value => new Date(`${value.replace(' ', 'T')}Z`).toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});

  // Neutral, semi-transparent colors so the blocks read well in the light and the dark theme.
  const css = `
    .mango-calls{display:grid;gap:8px}
    .mango-call{display:grid;grid-template-columns:22px 1fr auto;gap:4px 8px;align-items:center;font-size:12px}
    .mango-call i{font-style:normal;font-size:15px;text-align:center;opacity:.8}
    .mango-call.missed i,.mango-call.missed b{color:#d4545a}
    .mango-call small{opacity:.65}
    .mango-call audio{grid-column:2/-1;width:100%;height:32px}
    .mango-call a{color:#4d8fd6;cursor:pointer}
    .mango-journal{padding:0}
    .mango-journal-head{display:flex;gap:8px;padding:12px 16px;border-bottom:1px solid #8883}
    .mango-journal-head button{min-height:30px}
    .mango-journal .mango-call{padding:10px 16px;border-bottom:1px solid #8882;grid-template-columns:22px minmax(0,1.2fr) minmax(0,1fr) auto}
    .mango-journal .mango-call audio{grid-column:2/-1}
    .mango-empty{padding:30px;text-align:center;opacity:.6;font-size:12px}
    .mango-empty-deal{opacity:.6}`;
  if (!document.getElementById('mango-office-style')) {
    const style = document.createElement('style');
    style.id = 'mango-office-style';
    style.textContent = css;
    document.head.append(style);
  }

  function Call({call, journal}) {
    const icon = call.direction === 'incoming' ? (call.answered ? '↙' : '✕') : '↗';
    const title = call.direction === 'incoming' ? (call.answered ? 'Входящий' : 'Пропущенный') : (call.answered ? 'Исходящий' : 'Не дозвонились');
    const who = call.deal_name ? h('a', {onClick: () => api.openDeal(call.deal_id)}, call.deal_name) : call.contact_name || call.company_name || (call.lead_id ? 'Заявка в «Неразобранном»' : '');
    return h('div', {className: 'mango-call' + (call.direction === 'incoming' && !call.answered ? ' missed' : '')},
      h('i', {title}, icon),
      h('span', null, h('b', null, call.number), ' ', h('small', null, [title, call.duration, call.user_name].filter(Boolean).join(' · '))),
      journal ? h('span', null, who) : null,
      h('small', null, time(call.started_at)),
      call.has_recording ? h('audio', {controls: true, preload: 'none', src: api.url(`/recording/${encodeURIComponent(call.entry_id)}`)}) : null);
  }

  function DealCalls({deal}) {
    const [calls, setCalls] = useState(null);
    useEffect(() => { api.fetch(`/deal/${deal.id}`).then(setCalls).catch(() => setCalls([])); }, [deal.id]);
    if (!calls) return null;
    if (!calls.length) return h('p', {className: 'mango-empty-deal'}, 'Звонков по этой сделке пока не было.');
    return h('div', {className: 'mango-calls'}, calls.map(call => h(Call, {key: call.entry_id, call})));
  }

  function Journal() {
    const [filter, setFilter] = useState('all');
    const [calls, setCalls] = useState(null);
    useEffect(() => { setCalls(null); api.fetch(`/calls?filter=${filter}`).then(setCalls).catch(error => { api.notify(error.message); setCalls([]); }); }, [filter]);
    return h('div', {className: 'plugin-card mango-journal'},
      h('div', {className: 'mango-journal-head'}, [['all', 'Все звонки'], ['missed', 'Пропущенные']].map(([key, label]) => h('button', {key, type: 'button', className: filter === key ? 'blue-btn' : 'outline-btn', onClick: () => setFilter(key)}, label))),
      calls === null ? h('p', {className: 'mango-empty'}, 'Загрузка…')
        : calls.length ? calls.map(call => h(Call, {key: call.entry_id, call, journal: true}))
          : h('p', {className: 'mango-empty'}, 'Звонков пока нет. Проверьте адрес внешней системы в настройках плагина и в личном кабинете Mango Office.'));
  }

  api.addDealPanel({id: 'calls', title: 'Звонки Mango Office', render: DealCalls});
  api.addPage({id: 'calls', label: 'Звонки', title: 'Звонки', icon: 'phone', render: Journal});
}
