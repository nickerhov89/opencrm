import React,{useEffect,useState} from 'react';
import {RotateCcw,Trash2} from 'lucide-react';
import './trash.css';
import './security.css';

const money=value=>new Intl.NumberFormat('ru-RU').format(Number(value)||0)+' ₽';

const purgePath={deal:'deals',task:'tasks',contact:'contacts',company:'companies'};
export default function TrashDeals({api,isAdmin,onError,onRefresh}){
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
  const purge=async item=>{
    if(!window.confirm(item?`Удалить «${item.name}» навсегда? Запись, её история, заметки и файлы будут стёрты без возможности восстановления.`:`Очистить корзину раздела? Все ${deals.length} записей будут удалены навсегда вместе с историей и файлами.`))return;
    setBusy(item?.id??'all');
    try{await api('/trash/'+purgePath[kind]+(item?'/'+item.id:''),{method:'DELETE'});await load()}
    catch(error){onError(error)}
    finally{setBusy(null)}
  };
  return <div className="settings-body"><div className="settings-section-heading"><div><h2>Корзина</h2><p>Удалённые записи можно вернуть вместе с задачами, заметками и файлами.{isAdmin?' Администратор может удалить запись навсегда — например, по запросу клиента на удаление персональных данных.':''}</p></div></div><div className="trash-tabs">{[['deal','Сделки'],['task','Задачи'],['contact','Контакты'],['company','Компании']].map(([key,label])=><button key={key} className={kind===key?'active':''} onClick={()=>setKind(key)}>{label}</button>)}</div>{isAdmin&&deals.length>0&&<div className="trash-toolbar"><button disabled={busy!==null} onClick={()=>purge(null)}><Trash2 size={14}/> Очистить корзину</button></div>}<section className="settings-card trash-card"><div className={'trash-head '+(kind==='deal'?'':'trash-entity-row')}><span>{kind==='deal'?'СДЕЛКА':kind==='task'?'ЗАДАЧА':kind==='contact'?'КОНТАКТ':'КОМПАНИЯ'}</span>{kind==='deal'&&<><span>ЭТАП</span><span>БЮДЖЕТ</span></>}<span>УДАЛЕНА</span><span></span></div>{deals.map(deal=><div className={'trash-row '+(kind==='deal'?'':'trash-entity-row')} key={deal.id}><strong>{deal.name}</strong>{kind==='deal'&&<><span>{deal.stage_name}</span><span>{money(deal.amount)}</span></>}<span>{new Date(deal.deleted_at.replace(' ','T')).toLocaleString('ru-RU')}</span><span className="trash-actions"><button disabled={busy!==null} onClick={()=>restore(deal.id)}><RotateCcw size={15}/> Восстановить</button>{isAdmin&&<button className="trash-purge" disabled={busy!==null} onClick={()=>purge(deal)}><Trash2 size={15}/> Удалить навсегда</button>}</span></div>)}{deals.length===0&&<div className="trash-empty">Корзина пуста</div>}</section></div>;
}
