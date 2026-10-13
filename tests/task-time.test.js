import test from 'node:test';
import assert from 'node:assert/strict';
import {isUpcomingTask,taskBoardSchedule} from '../src/task-time.js';

test('task board uses relative Russian dates across a month boundary',()=>{
  const now=new Date(2026,9,31,12);
  assert.equal(taskBoardSchedule({due_at:new Date(2026,9,30,10).toISOString()},now),'Вчера, 10:00');
  assert.equal(taskBoardSchedule({due_at:new Date(2026,9,31,11).toISOString()},now),'Сегодня, 11:00');
  assert.equal(taskBoardSchedule({due_at:new Date(2026,10,1,10).toISOString(),duration_minutes:30},now),'Завтра, 10:00 - 10:30');
  assert.equal(taskBoardSchedule({due_at:new Date(2026,10,2,10).toISOString(),all_day:true},now),'02.11.2026, Весь день');
});

test('future open tasks stay separate from the activity history',()=>{
  const now=new Date(2026,9,13,12);
  assert.equal(isUpcomingTask({due_at:new Date(2026,9,14,10).toISOString()},now),true);
  assert.equal(isUpcomingTask({due_at:new Date(2026,9,13,23).toISOString()},now),false);
  assert.equal(isUpcomingTask({due_at:new Date(2026,9,14,10).toISOString(),completed_at:'2026-10-13T10:00:00.000Z'},now),false);
});
