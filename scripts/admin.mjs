// Server-side recovery for when the only administrator is locked out.
// Usage (run on the CRM host, ideally with the app stopped):
//   npm run admin -- reset-password <email>   prints a new random password
//   npm run admin -- reset-2fa <email>        turns off two-factor sign-in
//   npm run admin -- enable <email>           re-enables a disabled account
// Every command also ends all sessions of that user and is written to the audit log.
import {randomBytes,scryptSync} from 'node:crypto';
import {createDb} from '../server/db.js';

const [command,rawEmail]=process.argv.slice(2);
const email=String(rawEmail||'').trim().toLowerCase();
const commands=['reset-password','reset-2fa','enable'];
if(!commands.includes(command)||!email){console.error(`Использование: npm run admin -- ${commands.join('|')} <email>`);process.exit(1)}

const db=createDb();
try{
  const user=db.prepare('SELECT id,email FROM users WHERE email=?').get(email);
  if(!user)throw new Error(`Пользователь ${email} не найден`);
  let password='';
  db.transaction(()=>{
    if(command==='reset-password'){
      password=randomBytes(12).toString('base64url');
      const salt=randomBytes(16).toString('hex');
      db.prepare('UPDATE users SET password_hash=?,password_changed_at=CURRENT_TIMESTAMP WHERE id=?').run(`${salt}:${scryptSync(password,salt,64).toString('hex')}`,user.id);
    }
    if(command==='reset-2fa')db.prepare('UPDATE users SET totp_secret=NULL,totp_pending_secret=NULL,totp_last_counter=-1 WHERE id=?').run(user.id);
    if(command==='enable')db.prepare('UPDATE users SET disabled_at=NULL WHERE id=?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.prepare("INSERT INTO audit_log (user_id,actor,action,target,details,ip) VALUES (NULL,'cli',?,?,?,'')").run(`cli.${command}`,`user:${user.id} ${user.email}`,'Команда на сервере');
  })();
  console.log(password?`Новый пароль для ${user.email}: ${password}\nСмените его после входа в разделе «Безопасность».`:`Готово: ${command} для ${user.email}. Все сеансы завершены.`);
}catch(error){console.error(error.message);process.exitCode=1}
finally{db.close()}
