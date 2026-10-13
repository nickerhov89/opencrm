import {test} from 'node:test';
import assert from 'node:assert/strict';
import {entityHistoryItems} from '../src/entity-history-filter.js';

const entity = {
  created_at: '2026-10-01 09:00:00',
  activity: [{id: 1, event: 'Изменён ответственный', author: 'Анна', created_at: '2026-10-02 09:00:00'}],
  timeline_notes: [{id: 2, body: 'Обсудили пилот', author: 'Илья', created_at: '2026-10-03 09:00:00'}],
  tasks: [{id: 3, title: 'Позвонить по договору', task_type: 'Связаться', owner_name: 'Мария', created_at: '2026-10-04 09:00:00', due_at: '2099-10-04T09:00:00.000Z', completed_at: null}],
};

test('история контакта ищет события, заметки и будущие задачи', () => {
  assert.deepEqual(entityHistoryItems(entity, 'contact').map(item => item.type), ['note', 'event', 'event']);
  assert.deepEqual(entityHistoryItems(entity, 'contact', 'ПИЛОТ').map(item => item.type), ['note']);
  assert.deepEqual(entityHistoryItems(entity, 'contact', 'договору').map(item => item.id), [3]);
  assert.deepEqual(entityHistoryItems(entity, 'contact', '', 'task').map(item => item.id), [3]);
  assert.deepEqual(entityHistoryItems(entity, 'contact', '', 'event').map(item => item.event), ['Изменён ответственный', 'Контакт создан']);
  assert.deepEqual(entityHistoryItems(entity, 'company', 'Компания создана').map(item => item.event), ['Компания создана']);
});
