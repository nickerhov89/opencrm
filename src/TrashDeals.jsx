import React,{useEffect,useState} from 'react';
import {RotateCcw} from 'lucide-react';
import './trash.css';

const money=value=>new Intl.NumberFormat('ru-RU').format(Number(value)||0)+' ₽';

export default function TrashDeals({api,onError,onRefresh}){
  const [kind,setKind]=useState('deal');
  const [deals,setDeals]=useState([]);
  const [busy,setBusy]=useState(null);
  const load=()=>api(kind==='deal'?'/trash/deals':kind==='task'?'/trash/tasks':'/trash/entities?kind='+kind).then(setDeals).catch(onError);
  useEffect(()=>{load()},[kind]);
  const restore=async id=>{
    setBusy(id);
    try{
      await api('/'+(kind==='deal'?'deals':kind==='task'?'tasks':kind==='contact'?'contacts':'companies')+'/'+id+'/restore',{method:'POST'});
      await Promise.all([load(),onRefresh()]);
    }catch(error){onError(error)}
    finally{setBusy(null)}
  };
  return <div className="settings-body"><div className="settings-section-heading"><div><h2>Корзина</h2><p>Удалённые записи можно вернуть вместе с задачами, заметками и файлами.</p></div></div><div className="trash-tabs">{[['deal','Сделки'],['task','Задачи'],['contact','Контакты'],['company','Компании']].map(([key,label])=><button key={key} className={kind===key?'active':''} onClick={()=>setKind(key)}>{label}</button>)}</div><section className="settings-card trash-card"><div className={'trash-head '+(kind==='deal'?'':'trash-entity-row')}><span>{kind==='deal'?'СДЕЛКА':kind==='task'?'ЗАДАЧА':kind==='contact'?'КОНТАКТ':'КОМПАНИЯ'}</span>{kind==='deal'&&<><span>ЭТАП</span><span>БЮДЖЕТ</span></>}<span>УДАЛЕНА</span><span></span></div>{deals.map(deal=><div className={'trash-row '+(kind==='deal'?'':'trash-entity-row')} key={deal.id}><strong>{deal.name}</strong>{kind==='deal'&&<><span>{deal.stage_name}</span><span>{money(deal.amount)}</span></>}<span>{new Date(deal.deleted_at.replace(' ','T')).toLocaleString('ru-RU')}</span><button disabled={busy!==null} onClick={()=>restore(deal.id)}><RotateCcw size={15}/> Восстановить</button></div>)}{deals.length===0&&<div className="trash-empty">Корзина пуста</div>}</section></div>;
}
