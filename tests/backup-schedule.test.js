import {test} from 'node:test';
import assert from 'node:assert/strict';
import {msUntil} from '../scripts/backup.mjs';

test('ежедневный бэкап ждёт ближайшего указанного времени',()=>{
  const at=(h,m)=>{const d=new Date(2026,10,20,h,m,0,0);return d};
  assert.equal(msUntil('00:00',at(22,30)),90*60*1000,'вечером — до полуночи');
  assert.equal(msUntil('00:00',at(0,0)),24*3600*1000,'ровно в полночь — следующая через сутки');
  assert.equal(msUntil('00:00',at(0,1)),(23*60+59)*60*1000);
  assert.equal(msUntil('23:30',at(9,0)),(14*60+30)*60*1000);
  assert.throws(()=>msUntil('24:00'),/ЧЧ:ММ/);
  assert.throws(()=>msUntil('7:00'),/ЧЧ:ММ/);
});
