import {isUpcomingTask} from './task-time.js';

const parseDate = value => value ? new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z') : new Date(0);

export function entityHistoryItems(entity, kind, query = '', type = 'all') {
  const activities = entity.activity || [];
  const hasCreation = activities.some(item => /создан[а]?|импортирован[а]?/i.test(item.event));
  const needle = query.trim().toLocaleLowerCase('ru-RU');
  const searching = Boolean(needle || type !== 'all');
  return [
    ...activities.map(item => ({...item, type: 'event', at: item.created_at})),
    ...(entity.timeline_notes || []).map(item => ({...item, type: 'note', at: item.created_at})),
    ...(entity.tasks || []).filter(item => searching || !isUpcomingTask(item)).map(item => ({...item, type: 'task', at: item.completed_at || (isUpcomingTask(item) ? item.due_at : item.created_at)})),
    ...(!hasCreation && entity.created_at ? [{id: 0, type: 'event', at: entity.created_at, created_at: entity.created_at, event: kind === 'contact' ? 'Контакт создан' : 'Компания создана', author: 'Система'}] : []),
  ].filter(item => {
    if (type !== 'all' && item.type !== type) return false;
    return !needle || [item.event, item.body, item.title, item.task_type, item.completion_result, item.author, item.owner_name].some(value => String(value || '').toLocaleLowerCase('ru-RU').includes(needle));
  }).sort((a, b) => parseDate(b.at) - parseDate(a.at) || b.id - a.id);
}
