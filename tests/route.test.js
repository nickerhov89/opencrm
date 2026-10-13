import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRoute,pathForDeal,pathForEntity,pathForView} from '../src/route.js';

test('routes resolve cards and sections from shareable URLs',()=>{
  assert.deepEqual(parseRoute('/deals/42'),{kind:'deal',id:42});
  assert.deepEqual(parseRoute('/contacts/7/'),{kind:'entity',entityKind:'contact',id:7});
  assert.deepEqual(parseRoute('/companies/8'),{kind:'entity',entityKind:'company',id:8});
  assert.deepEqual(parseRoute('/deals?ignored','?pipeline=3'),{kind:'unknown'});
  assert.deepEqual(parseRoute('/deals','?pipeline=3'),{kind:'view',view:'deals',pipelineId:3});
  assert.deepEqual(parseRoute('/deals/all'),{kind:'allDeals'});
  assert.deepEqual(parseRoute('/tasks'),{kind:'view',view:'tasks'});
  assert.equal(pathForDeal(42),'/deals/42');
  assert.equal(pathForEntity('contact',7),'/contacts/7');
  assert.equal(pathForView('settings'),'/settings');
});
