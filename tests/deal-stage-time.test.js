import test from 'node:test';
import assert from 'node:assert/strict';
import {stageDuration} from '../src/deal-stage-time.js';

test('stage age uses last transition time and Russian day forms',()=>{
  const now=new Date('2026-10-13T12:00:00.000Z');
  assert.equal(stageDuration('2026-10-13 11:00:00',now),'0 дней');
  assert.equal(stageDuration('2026-10-12 12:00:00',now),'1 день');
  assert.equal(stageDuration('2026-10-11 12:00:00',now),'2 дня');
  assert.equal(stageDuration('2026-10-02 12:00:00',now),'11 дней');
  assert.equal(stageDuration('2026-09-22 12:00:00',now),'21 день');
});
