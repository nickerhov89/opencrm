export function stageDuration(stageSince,now=new Date()){
  if(!stageSince)return '';
  const parsed=new Date(stageSince.includes('T')?stageSince:stageSince.replace(' ','T')+'Z');
  if(!Number.isFinite(parsed.getTime()))return '';
  const days=Math.max(0,Math.floor((now.getTime()-parsed.getTime())/86400000));
  const noun=days%10===1&&days%100!==11?'день':days%10>=2&&days%10<=4&&(days%100<12||days%100>14)?'дня':'дней';
  return `${days} ${noun}`;
}
