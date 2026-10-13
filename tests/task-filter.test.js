import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyTaskFilter,matchTaskFilter} from '../src/task-filter.js';

test('task filter combines owner, type, date and overdue status',()=>{
  const task={owner_id:7,task_type:'Встреча',due_at:'2026-10-13T12:00:00.000Z',completed_at:null};
  const now=new Date('2026-10-13T13:00:00.000Z');
  assert.equal(matchTaskFilter(task,emptyTaskFilter,7,now),true);
  assert.equal(matchTaskFilter(task,{...emptyTaskFilter,preset:'mine'},7,now),true);
  assert.equal(matchTaskFilter(task,{...emptyTaskFilter,preset:'mine'},8,now),false);
  assert.equal(matchTaskFilter(task,{...emptyTaskFilter,preset:'overdue'},7,now),true);
  assert.equal(matchTaskFilter({...task,completed_at:'2026-10-13T12:30:00.000Z'},{...emptyTaskFilter,preset:'overdue'},7,now),false);
  assert.equal(matchTaskFilter(task,{...emptyTaskFilter,type:'Письмо'},7,now),false);
  assert.equal(matchTaskFilter(task,{...emptyTaskFilter,owner:'8'},7,now),false);
  assert.equal(matchTaskFilter(task,{...emptyTaskFilter,dueFrom:'2026-10-14'},7,now),false);
});
