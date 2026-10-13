const parse=value=>value?new Date(String(value).replace(' ','T')):null;
const clock=date=>date.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});

export const taskTime=task=>{
  const start=parse(task.due_at);
  if(!start||!Number.isFinite(start.getTime()))return '';
  if(task.all_day)return 'Весь день';
  const duration=Number(task.duration_minutes)||0;
  return duration>0?`${clock(start)}–${clock(new Date(start.getTime()+duration*60000))}`:clock(start);
};

export const taskSchedule=task=>{
  const date=parse(task.due_at);
  if(!date||!Number.isFinite(date.getTime()))return 'Без срока';
  return `${date.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'})} ${taskTime(task)}`;
};

export const taskBoardSchedule=(task,now=new Date())=>{
  const date=parse(task.due_at);
  if(!date||!Number.isFinite(date.getTime()))return 'Без срока';
  const day=new Date(date.getFullYear(),date.getMonth(),date.getDate());
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const offset=Math.round((day-today)/86400000);
  const label=offset===-1?'Вчера':offset===0?'Сегодня':offset===1?'Завтра':date.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'});
  const time=taskTime(task).replace('–',' - ');
  return `${label}, ${time}`;
};

export const isUpcomingTask=(task,now=new Date())=>{
  if(task.completed_at||!task.due_at)return false;
  const due=parse(task.due_at);
  if(!due||!Number.isFinite(due.getTime()))return false;
  const tomorrow=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  return due>=tomorrow;
};
