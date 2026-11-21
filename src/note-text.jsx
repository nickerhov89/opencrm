import React, {useState} from 'react';

// Notes moved from amoCRM keep HTML entities (&amp;, &quot;, &#8212;…). They are shown decoded;
// the stored text is not changed.
const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',laquo:'«',raquo:'»',mdash:'—',ndash:'–',hellip:'…',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'„',bull:'•',copy:'©',reg:'®',trade:'™',euro:'€',times:'×',deg:'°',numero:'№'};
export function decodeEntities(text){
  return String(text??'').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi,(whole,code)=>{
    if(code[0]==='#'){const n=code[1].toLowerCase()==='x'?parseInt(code.slice(2),16):Number(code.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):whole}
    return named[code.toLowerCase()]??whole;
  });
}

// Long text collapses to a few lines with «Показать полностью», as in the amoCRM feed.
export function CollapsibleText({text,lines=8,chars=600,className=''}){
  const [open,setOpen]=useState(false),value=decodeEntities(text);
  const long=value.length>chars||value.split('\n').length>lines;
  return <><p className={className+(long&&!open?' text-collapsed':'')}>{value}</p>{long&&<button type="button" className="text-more" onClick={()=>setOpen(current=>!current)}>{open?'Свернуть':'Показать полностью'}</button>}</>;
}
