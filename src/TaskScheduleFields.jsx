import React from 'react';
import './task-schedule.css';

const minutes=time=>{const [hours,mins]=String(time||'').split(':').map(Number);return Number.isInteger(hours)&&Number.isInteger(mins)?hours*60+mins:0};
const clock=total=>`${String(Math.floor(total/60)%24).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;

export default function TaskScheduleFields({form,set}){
  const date=form.due_at?.slice(0,10)||'',start=form.due_at?.slice(11,16)||'12:00';
  const duration=Number(form.duration_minutes)||0;
  const end=clock(minutes(start)+duration);
  return <div className="task-schedule-fields">
    <label>Дата задачи<input type="date" required value={date} onChange={event=>set('due_at',event.target.value?`${event.target.value}T${start}`:'')}/></label>
    <label className="task-all-day"><input type="checkbox" checked={!!form.all_day} onChange={event=>set('all_day',event.target.checked)}/> Весь день</label>
    {!form.all_day&&<div className="task-time-range"><label>С<input type="time" required value={start} onChange={event=>set('due_at',`${date}T${event.target.value}`)}/></label><span>—</span><label>До<input type="time" required value={end} min={start} onChange={event=>{const length=minutes(event.target.value)-minutes(start);set('duration_minutes',Math.max(0,length))}}/></label></div>}
  </div>;
}
