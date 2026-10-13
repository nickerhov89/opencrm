import React from 'react';
import {Building2,ChevronRight,Mail,Phone} from 'lucide-react';
import './deal-company.css';

export default function DealCompany({deal,onOpen}){
  if(!deal.company_name)return null;
  const details=[
    ['Телефон',deal.company_phone,deal.company_phone?`tel:${deal.company_phone.replace(/[^+\d]/g,'')}`:null],
    ['Email',deal.company_email,deal.company_email?`mailto:${deal.company_email.replace(/[\r\n?#]/g,'')}`:null],
    ['Сайт',deal.company_website,null],
    ['Адрес',deal.company_address,null]
  ].filter(([,value])=>value);
  return <section className="deal-company"><h2>КОМПАНИЯ</h2><div className="deal-company-card"><button className="deal-company-title" onClick={()=>onOpen(deal.company_id)}><span className="deal-company-avatar"><Building2 size={19}/></span><b>{deal.company_name}</b><ChevronRight size={16}/></button>{details.length>0&&<div className="deal-company-details">{details.map(([label,value,href])=><div key={label}><span>{label}</span>{href?<a href={href}>{label==='Телефон'&&<Phone size={12}/>} {label==='Email'&&<Mail size={12}/>} {value}</a>:<b>{value}</b>}</div>)}</div>}</div></section>;
}
