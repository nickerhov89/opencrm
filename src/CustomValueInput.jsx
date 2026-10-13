import React from 'react';

export const fieldChoices=field=>{try{const parsed=JSON.parse(field?.options_json||'[]');return Array.isArray(parsed)?parsed:[]}catch{return []}};

export default function CustomValueInput({field,value,onChange,autoFocus=false,onKeyDown}){
  if(field?.field_type==='select')return <select autoFocus={autoFocus} value={value} onChange={event=>onChange(event.target.value)} onKeyDown={onKeyDown}><option value="">—</option>{fieldChoices(field).map(option=><option key={option} value={option}>{option}</option>)}</select>;
  return <input autoFocus={autoFocus} type={field?.field_type==='number'?'number':field?.field_type==='date'?'date':field?.field_type==='url'?'url':'text'} maxLength={1000} value={value} onChange={event=>onChange(event.target.value)} onKeyDown={onKeyDown}/>;
}
