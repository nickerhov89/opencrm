const collator=new Intl.Collator('ru',{numeric:true,sensitivity:'base'});

export function dealSortValue(deal,key){
  if(key==='amount')return Number(deal.amount)||0;
  if(key==='created'||key==='updated')return deal[key+'_at']||'';
  if(key.startsWith('field:')){
    try{return JSON.parse(deal.custom_values||'{}')[key.slice(6)]??''}catch{return ''}
  }
  const property={contact:'contact_name',company:'company_name',stage:'stage_name',loss_reason:'loss_reason',owner:'owner_name',pipeline:'pipeline_name'}[key]||key;
  return deal[property]??'';
}

export function sortDeals(deals,key,direction='asc',customFields=[]){
  if(!key)return deals;
  const field=key.startsWith('field:')?customFields.find(item=>String(item.id)===key.slice(6)):null;
  const numeric=key==='amount'||field?.field_type==='number';
  const sign=direction==='desc'?-1:1;
  return deals.map((deal,index)=>({deal,index,value:dealSortValue(deal,key)})).sort((a,b)=>{
    const aEmpty=a.value===''||a.value===null;
    const bEmpty=b.value===''||b.value===null;
    if(aEmpty!==bEmpty)return aEmpty?1:-1;
    const comparison=numeric?(Number(a.value)||0)-(Number(b.value)||0):collator.compare(String(a.value),String(b.value));
    return comparison*sign||a.index-b.index;
  }).map(item=>item.deal);
}
