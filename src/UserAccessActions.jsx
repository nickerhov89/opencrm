import React,{useState} from 'react';
import {KeyRound,LogOut,ShieldOff,UserCheck,UserX} from 'lucide-react';
import './security.css';

// Rendered inside the user editor form, so it uses plain buttons rather than a nested <form>.
export default function UserAccessActions({user,api,isSelf,onChanged}){
  const [state,setState]=useState({disabled:!!user.disabled,totp:!!user.totp_enabled});
  const [password,setPassword]=useState(''),[resetting,setResetting]=useState(false);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const run=async(path,body,done)=>{
    setBusy(true);setError('');setNotice('');
    try{const result=await api(`/users/${user.id}/${path}`,{method:'POST',body});done(result);await onChanged?.()}
    catch(failure){setError(failure.message)}
    finally{setBusy(false)}
  };
  const sessions=count=>count?` Завершено сеансов: ${count}.`:'';
  const resetPassword=()=>{
    if(password.length<10){setError('Пароль должен быть не короче 10 символов');return}
    run('password',{password},result=>{setPassword('');setResetting(false);setNotice('Пароль изменён. Передайте его сотруднику лично.'+sessions(result.revoked_sessions))});
  };
  const toggle=()=>{
    if(!state.disabled&&!window.confirm(`Отключить доступ для ${user.name}? Сотрудник сразу выйдет со всех устройств, его записи останутся в CRM.`))return;
    run(state.disabled?'enable':'disable',undefined,result=>{setState(current=>({...current,disabled:!current.disabled}));setNotice(state.disabled?'Доступ восстановлен.':'Доступ отключён.'+sessions(result.revoked_sessions))});
  };
  return <section className="user-rights-card user-access-actions">
    <h3>Доступ и безопасность</h3>
    <p className="user-access-status">{state.disabled?<b className="security-badge danger">Доступ отключён</b>:<b className="security-badge ok">Активен</b>}{state.totp?<b className="security-badge ok">2FA включена</b>:<b className="security-badge muted">2FA выключена</b>}</p>
    {isSelf?<p className="security-hint">Свой пароль и двухфакторную защиту меняйте в разделе «Безопасность».</p>:<div className="user-access-buttons">
      {resetting?<div className="user-access-reset"><input type="password" autoFocus minLength={10} maxLength={1024} value={password} onChange={event=>setPassword(event.target.value)} placeholder="Новый пароль, от 10 символов" aria-label="Новый пароль сотрудника" onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();resetPassword()}}}/><button type="button" className="blue-btn" disabled={busy} onClick={resetPassword}>Сохранить пароль</button><button type="button" disabled={busy} onClick={()=>{setResetting(false);setPassword('')}}>Отмена</button></div>
        :<button type="button" disabled={busy} onClick={()=>setResetting(true)}><KeyRound size={14}/> Задать новый пароль</button>}
      <button type="button" disabled={busy} onClick={()=>run('revoke-sessions',undefined,result=>setNotice('Сотрудник вышел со всех устройств.'+sessions(result.revoked_sessions)))}><LogOut size={14}/> Завершить все сеансы</button>
      {state.totp&&<button type="button" disabled={busy} onClick={()=>{if(window.confirm('Сбросить двухфакторную защиту? Сотрудник сможет войти только по паролю и должен будет настроить её заново.'))run('reset-2fa',undefined,result=>{setState(current=>({...current,totp:false}));setNotice('Двухфакторная защита сброшена.'+sessions(result.revoked_sessions))})}}><ShieldOff size={14}/> Сбросить 2FA</button>}
      <button type="button" className={state.disabled?'':'danger'} disabled={busy} onClick={toggle}>{state.disabled?<><UserCheck size={14}/> Включить доступ</>:<><UserX size={14}/> Отключить доступ</>}</button>
    </div>}
    {notice&&<p className="security-notice" role="status">{notice}</p>}
    {error&&<p className="security-error" role="alert">{error}</p>}
  </section>;
}
