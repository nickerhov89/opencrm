export const emptyTaskFilter={preset:'',owner:'',type:'',dueFrom:'',dueTo:''};

export function matchTaskFilter(task,filter,currentUserId,now=new Date()){
  if(filter.owner&&String(task.owner_id)!==String(filter.owner))return false;
  if(filter.type&&task.task_type!==filter.type)return false;
  const due=task.due_at?new Date(String(task.due_at).replace(' ','T')):null;
  const date=due&&Number.isFinite(due.getTime())?`${due.getFullYear()}-${String(due.getMonth()+1).padStart(2,'0')}-${String(due.getDate()).padStart(2,'0')}`:'';
  if(filter.dueFrom&&(!date||date<filter.dueFrom)||filter.dueTo&&(!date||date>filter.dueTo))return false;
  if(filter.preset==='mine'&&String(task.owner_id)!==String(currentUserId))return false;
  if(filter.preset==='overdue'&&(task.completed_at||!due||due>=now))return false;
  return true;
}
