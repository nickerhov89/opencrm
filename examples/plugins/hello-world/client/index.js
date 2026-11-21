// Browser part: a plain ES module loaded by OpenCRM after sign-in. It cannot import packages,
// so React comes from the host: api.React (and api.h = React.createElement).
export default function activate(api) {
  const {h, useState, useEffect} = api;

  function StatsPage() {
    const [stats, setStats] = useState(null);
    useEffect(() => { api.fetch('/stats').then(setStats).catch(error => api.notify(error.message)); }, []);
    return h('div', {className: 'plugin-card'},
      h('h2', null, api.settings.greeting),
      h('p', null, `Вы вошли как ${api.user.name}.`),
      stats ? h('ul', null,
        h('li', null, `Сделок: ${stats.deals}`),
        h('li', null, `Заявок в «Неразобранном»: ${stats.leads}`),
        h('li', null, `Смен этапа, которые видел плагин: ${stats.stage_changes}`)) : h('p', null, 'Загрузка…'));
  }

  function DealPanel({deal}) {
    const [info, setInfo] = useState(null);
    useEffect(() => { api.fetch(`/deal/${deal.id}`).then(setInfo).catch(() => setInfo(null)); }, [deal.id]);
    if (!info) return null;
    return h('p', null, `Сделке ${info.days} дн. Карточку открывали ${info.opened} раз.`);
  }

  api.addPage({id: 'stats', label: 'Пример', icon: 'sparkles', title: 'Пример плагина', render: StatsPage});
  api.addDealPanel({id: 'age', title: 'Пример плагина', render: DealPanel});
}
