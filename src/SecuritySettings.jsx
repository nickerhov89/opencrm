import React,{useEffect,useState} from 'react';
import {KeyRound,LogOut,ShieldCheck} from 'lucide-react';
import './security.css';

const groupSecret=secret=>secret.replace(/(.{4})/g,'$1 ').trim();

export default function SecuritySettings({auth,api,onError,onAuthChange}){
  const [sessions,setSessions]=useState(null);
  const [passwordForm,setPasswordForm]=useState({current_password:'',new_password:'',repeat:'',code:''});
  const [twoFactor,setTwoFactor]=useState({enabled:!!auth.totp_enabled,step:'idle',password:'',code:'',secret:'',url:''});
  const [busy,setBusy]=useState(''),[notice,setNotice]=useState('');
  const loadSessions=()=>api('/me/sessions').then(data=>setSessions(data.active)).catch(onError);
  useEffect(()=>{loadSessions()},[]);
  const act=async(key,work)=>{setBusy(key);setNotice('');try{await work()}catch(error){onError(error)}finally{setBusy('')}};
  const changePassword=event=>{event.preventDefault();if(passwordForm.new_password!==passwordForm.repeat){onError(new Error('Новые пароли не совпадают'));return}
    act('password',async()=>{const result=await api('/me/password',{method:'POST',body:{current_password:passwordForm.current_password,new_password:passwordForm.new_password,code:passwordForm.code}});setPasswordForm({current_password:'',new_password:'',repeat:'',code:''});setNotice(`Пароль изменён.${result.revoked_sessions?` Завершено других сеансов: ${result.revoked_sessions}.`:''}`);loadSessions()})};
  const startTwoFactor=event=>{event.preventDefault();act('2fa',async()=>{const result=await api('/me/2fa/setup',{method:'POST',body:{current_password:twoFactor.password}});setTwoFactor(current=>({...current,step:'confirm',password:'',code:'',secret:result.secret,url:result.otpauth_url}))})};
  const confirmTwoFactor=event=>{event.preventDefault();act('2fa',async()=>{const result=await api('/me/2fa/enable',{method:'POST',body:{code:twoFactor.code}});setTwoFactor({enabled:true,step:'idle',password:'',code:'',secret:'',url:''});onAuthChange?.({totp_enabled:true});setNotice(`Двухфакторная защита включена.${result.revoked_sessions?` Другие сеансы завершены: ${result.revoked_sessions}.`:''}`);loadSessions()})};
  const disableTwoFactor=event=>{event.preventDefault();act('2fa',async()=>{await api('/me/2fa/disable',{method:'POST',body:{current_password:twoFactor.password,code:twoFactor.code}});setTwoFactor({enabled:false,step:'idle',password:'',code:'',secret:'',url:''});onAuthChange?.({totp_enabled:false});setNotice('Двухфакторная защита выключена.')})};
  const revokeOthers=()=>act('sessions',async()=>{const result=await api('/me/sessions/revoke-others',{method:'POST'});setNotice(result.revoked_sessions?`Завершено других сеансов: ${result.revoked_sessions}.`:'Других активных сеансов нет.');loadSessions()});
  const setPw=(key,value)=>setPasswordForm(current=>({...current,[key]:value}));
  const set2fa=(key,value)=>setTwoFactor(current=>({...current,[key]:value}));
  return <div className="settings-body security-page">
    <div className="settings-section-heading"><div><h2>Безопасность</h2><p>Пароль, вход по коду и активные сеансы вашей учётной записи {auth.email}.</p></div></div>
    {notice&&<p className="security-notice" role="status">{notice}</p>}
    <section className="settings-card"><div className="settings-card-title"><div><h2><KeyRound size={16}/> Пароль</h2><p>После смены пароля вы останетесь в системе здесь, а на остальных устройствах сеансы завершатся.</p></div></div>
      <form onSubmit={changePassword}>
        <div className="settings-form-row"><label htmlFor="security-current">Текущий пароль</label><input id="security-current" type="password" autoComplete="current-password" required maxLength={1024} value={passwordForm.current_password} onChange={event=>setPw('current_password',event.target.value)}/></div>
        <div className="settings-form-row"><label htmlFor="security-new">Новый пароль</label><input id="security-new" type="password" autoComplete="new-password" required minLength={10} maxLength={1024} value={passwordForm.new_password} onChange={event=>setPw('new_password',event.target.value)} placeholder="Не менее 10 символов"/></div>
        <div className="settings-form-row"><label htmlFor="security-repeat">Повторите пароль</label><input id="security-repeat" type="password" autoComplete="new-password" required minLength={10} maxLength={1024} value={passwordForm.repeat} onChange={event=>setPw('repeat',event.target.value)}/></div>
        {twoFactor.enabled&&<div className="settings-form-row"><label htmlFor="security-pw-code">Код из приложения</label><input id="security-pw-code" inputMode="numeric" autoComplete="one-time-code" required maxLength={7} value={passwordForm.code} onChange={event=>setPw('code',event.target.value)} placeholder="123 456"/></div>}
        <div className="settings-save"><button className="blue-btn" disabled={busy==='password'}>{busy==='password'?'СОХРАНЯЕМ…':'СМЕНИТЬ ПАРОЛЬ'}</button></div>
      </form>
    </section>
    <section className="settings-card"><div className="settings-card-title"><div><h2><ShieldCheck size={16}/> Двухфакторная защита</h2><p>При входе, кроме пароля, понадобится код из приложения-аутентификатора: Яндекс Ключ, Google Authenticator, 1Password и подобных.</p></div>{twoFactor.enabled?<b className="security-badge ok">Включена</b>:<b className="security-badge muted">Выключена</b>}</div>
      {!twoFactor.enabled&&twoFactor.step==='idle'&&<form onSubmit={startTwoFactor}><div className="settings-form-row"><label htmlFor="security-2fa-pass">Текущий пароль</label><input id="security-2fa-pass" type="password" autoComplete="current-password" required maxLength={1024} value={twoFactor.password} onChange={event=>set2fa('password',event.target.value)}/></div><div className="settings-save"><button className="blue-btn" disabled={busy==='2fa'}>НАСТРОИТЬ</button></div></form>}
      {!twoFactor.enabled&&twoFactor.step==='confirm'&&<form onSubmit={confirmTwoFactor}><div className="security-secret"><p>1. Добавьте аккаунт в приложении вручную и введите этот ключ (тип — по времени):</p><code aria-label="Секретный ключ">{groupSecret(twoFactor.secret)}</code><p>На телефоне можно открыть ссылку сразу в приложении: <a href={twoFactor.url}>добавить в аутентификатор</a>.</p><p>2. Введите шестизначный код, который покажет приложение.</p></div><div className="settings-form-row"><label htmlFor="security-2fa-code">Код из приложения</label><input id="security-2fa-code" autoFocus inputMode="numeric" autoComplete="one-time-code" required maxLength={7} value={twoFactor.code} onChange={event=>set2fa('code',event.target.value)} placeholder="123 456"/></div><div className="settings-save security-actions"><button type="button" onClick={()=>setTwoFactor(current=>({...current,step:'idle',secret:'',url:'',code:''}))}>Отмена</button><button className="blue-btn" disabled={busy==='2fa'}>ВКЛЮЧИТЬ</button></div></form>}
      {twoFactor.enabled&&<form onSubmit={disableTwoFactor}><div className="settings-form-row"><label htmlFor="security-off-pass">Текущий пароль</label><input id="security-off-pass" type="password" autoComplete="current-password" required maxLength={1024} value={twoFactor.password} onChange={event=>set2fa('password',event.target.value)}/></div><div className="settings-form-row"><label htmlFor="security-off-code">Код из приложения</label><input id="security-off-code" inputMode="numeric" autoComplete="one-time-code" required maxLength={7} value={twoFactor.code} onChange={event=>set2fa('code',event.target.value)} placeholder="123 456"/></div><div className="settings-save"><button className="danger-btn" disabled={busy==='2fa'}>ВЫКЛЮЧИТЬ 2FA</button></div></form>}
    </section>
    <section className="settings-card"><div className="settings-card-title"><div><h2><LogOut size={16}/> Сеансы</h2><p>Активных входов в вашу учётную запись: {sessions??'…'}. Если потеряли ноутбук или телефон, завершите остальные сеансы.</p></div><button type="button" className="security-link" disabled={busy==='sessions'} onClick={revokeOthers}>Выйти на других устройствах</button></div></section>
  </div>;
}
