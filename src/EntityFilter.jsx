import React,{useEffect,useState} from 'react';
import {CalendarDays,RotateCcw,X} from 'lucide-react';
import './deal-filter.css';

export const emptyEntityFilter={owner_id:'',tag:'',preset:'',created_from:'',created_to:''};

export default function EntityFilter({kind,filter,users,api,onApply,onReset,onClose}){
  const [draft,setDraft]=useState(filter),[tags,setTags]=useState([]),[tagSearch,setTagSearch]=useState('');
  useEffect(()=>setDraft(filter),[filter]);
  useEffect(()=>{let active=true;api('/entity-tags?kind='+kind).then(items=>{if(active)setTags(items)}).catch(()=>{});return()=>{active=false}},[kind,api]);
  const change=(key,value)=>setDraft(current=>({...current,[key]:value}));
  return <><button className="deal-filter-scrim" aria-label="Закрыть фильтр" onClick={onClose}/><section className="deal-filter entity-filter" aria-label="Фильтр списков">
    <div className="deal-filter-columns">
      <div className="deal-filter-presets"><h3>БЫСТРЫЕ ФИЛЬТРЫ</h3><button className={!Object.values(draft).some(Boolean)?'selected':''} onClick={()=>onApply(emptyEntityFilter)}>Полный список</button><button className={draft.preset==='no_tasks'?'selected':''} onClick={()=>onApply({...emptyEntityFilter,preset:'no_tasks'})}>Без задач</button><button className={draft.preset==='overdue'?'selected':''} onClick={()=>onApply({...emptyEntityFilter,preset:'overdue'})}>С просроченными задачами</button><button className={draft.preset==='no_deals'?'selected':''} onClick={()=>onApply({...emptyEntityFilter,preset:'no_deals'})}>Без сделок</button><button onClick={()=>onApply({...emptyEntityFilter,owner_id:'unassigned'})} className={draft.owner_id==='unassigned'?'selected':''}>Без ответственного</button></div>
      <div className="deal-filter-properties"><h3>СВОЙСТВА</h3><label>Дата создания<div className="filter-date-pair"><CalendarDays size={16}/><input type="date" value={draft.created_from} max={draft.created_to||undefined} onChange={event=>change('created_from',event.target.value)}/><span>—</span><input type="date" value={draft.created_to} min={draft.created_from||undefined} onChange={event=>change('created_to',event.target.value)}/></div></label><label>Ответственный<select value={draft.owner_id} onChange={event=>change('owner_id',event.target.value)}><option value="">Все сотрудники</option><option value="unassigned">Не назначен</option>{users.map(user=><option value={user.id} key={user.id}>{user.name}</option>)}</select></label><label>Тег<input value={draft.tag} onChange={event=>change('tag',event.target.value)} placeholder="Точное название тега"/></label></div>
      <div className="deal-filter-tags"><h3>ТЕГИ</h3><input value={tagSearch} onChange={event=>setTagSearch(event.target.value)} placeholder="Найти тег"/><div className="deal-filter-tag-list">{tags.filter(item=>item.tag.toLocaleLowerCase('ru-RU').includes(tagSearch.toLocaleLowerCase('ru-RU'))).map(item=><button key={item.tag} onClick={()=>change('tag',item.tag)}><span>{item.tag}</span><small>{item.count}</small></button>)}</div>{!tags.length&&<p>Тегов пока нет</p>}</div>
    </div><footer className="deal-filter-actions"><button onClick={()=>{setDraft(emptyEntityFilter);onReset()}}><RotateCcw size={14}/> Сбросить</button><button className="deal-filter-close" onClick={onClose}><X size={15}/> Закрыть</button><button className="blue-btn" onClick={()=>onApply(draft)}>Применить</button></footer>
  </section></>;
}
