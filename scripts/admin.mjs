// Server-side account recovery and first setup.
// Usage (run on the CRM host; in Docker: docker compose exec opencrm node scripts/admin.mjs ...):
//   create-admin <email> [name]   creates an administrator and prints a random password
//   reset-password <email>        prints a new random password
//   reset-2fa <email>             turns off two-factor sign-in
//   enable <email>                re-enables a disabled account
//   sync-ids                      after loading rows with explicit IDs (e.g. from amoCRM), moves the ID
//                                 sequences past the largest IDs; the app also does this on every start
// Every command except create-admin also ends all sessions of that user. All are written to the audit log.
import {randomBytes,scryptSync} from 'node:crypto';
import {createDb} from '../server/db.js';

const [command,rawEmail,...nameParts]=process.argv.slice(2);
const email=String(rawEmail||'').trim().toLowerCase();
const commands=['create-admin','reset-password','reset-2fa','enable'];
if(command==='sync-ids'){
  const db=await createDb();
  try{const fixed=(await db.query('SELECT sync_id_sequences() n')).rows[0].n;console.log(`Счётчики ID выровнены, исправлено таблиц: ${fixed}`)}
  finally{await db.close()}
  process.exit(0);
}
if(!commands.includes(command)||!email||!email.includes('@')||email.length>254){console.error(`Использование: node scripts/admin.mjs ${commands.join('|')} <email> [имя]\n               node scripts/admin.mjs sync-ids`);process.exit(1)}

const newPassword=()=>{const password=randomBytes(12).toString('base64url'),salt=randomBytes(16).toString('hex');return {password,hash:`${salt}:${scryptSync(password,salt,64).toString('hex')}`}};
const log=(userId,target)=>db.prepare("INSERT INTO audit_log (user_id,actor,action,target,details,ip) VALUES (?,'cli',?,?,?,'')").run(userId,`cli.${command}`,target,'Команда на сервере');

const db=await createDb();
try{
  if(command==='create-admin'){
    const name=(nameParts.join(' ').trim()||'Администратор').slice(0,120);
    const {password,hash}=newPassword();
    const id=await db.transaction(async()=>{
      if(await db.prepare('SELECT id FROM users WHERE email=?').get(email))throw new Error(`Пользователь ${email} уже есть. Для смены пароля: reset-password`);
      const created=(await db.prepare("INSERT INTO users (name,email,password_hash,role,password_changed_at) VALUES (?,?,?,'admin',CURRENT_TIMESTAMP)").run(name,email,hash)).lastInsertRowid;
      await log(created,`user:${created} ${email}`);
      return created;
    })();
    console.log(`Администратор ${email} создан (id ${id}).\nПароль: ${password}\nВойдите и смените его в «Настройки → Безопасность».`);
  }else{
    const user=await db.prepare('SELECT id,email FROM users WHERE email=?').get(email);
    if(!user)throw new Error(`Пользователь ${email} не найден`);
    let password='';
    await db.transaction(async()=>{
      if(command==='reset-password'){
        const fresh=newPassword();password=fresh.password;
        await db.prepare('UPDATE users SET password_hash=?,password_changed_at=CURRENT_TIMESTAMP WHERE id=?').run(fresh.hash,user.id);
      }
      if(command==='reset-2fa')await db.prepare('UPDATE users SET totp_secret=NULL,totp_pending_secret=NULL,totp_last_counter=-1 WHERE id=?').run(user.id);
      if(command==='enable')await db.prepare('UPDATE users SET disabled_at=NULL WHERE id=?').run(user.id);
      await db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      await log(null,`user:${user.id} ${user.email}`);
    })();
    console.log(password?`Новый пароль для ${user.email}: ${password}\nСмените его после входа в разделе «Безопасность».`:`Готово: ${command} для ${user.email}. Все сеансы завершены.`);
  }
}catch(error){console.error(error.message);process.exitCode=1}
finally{await db.close()}
