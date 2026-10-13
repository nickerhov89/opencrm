import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sortDeals} from '../src/deal-table-sort.js';

const deals=[
  {id:1,name:'Сделка 10',amount:20,contact_name:'Яна',created_at:'2026-10-01 10:00:00',custom_values:'{"7":"12"}'},
  {id:2,name:'Сделка 2',amount:100,contact_name:'Анна',created_at:'2026-09-01 10:00:00',custom_values:'{"7":"3"}'},
  {id:3,name:'Сделка 3',amount:20,contact_name:'',created_at:'2026-10-02 10:00:00',custom_values:'{}'},
];

test('сортировка списка учитывает текст, суммы, даты и пустые значения',()=>{
  assert.deepEqual(sortDeals(deals,'name').map(deal=>deal.id),[2,3,1]);
  assert.deepEqual(sortDeals(deals,'amount','desc').map(deal=>deal.id),[2,1,3]);
  assert.deepEqual(sortDeals(deals,'created','desc').map(deal=>deal.id),[3,1,2]);
  assert.deepEqual(sortDeals(deals,'contact','desc').map(deal=>deal.id),[1,2,3]);
  assert.deepEqual(sortDeals(deals,'field:7','asc',[{id:7,field_type:'number'}]).map(deal=>deal.id),[2,1,3]);
  assert.deepEqual(deals.map(deal=>deal.id),[1,2,3]);
});
