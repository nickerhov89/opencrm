import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLoginLimiter,createRateLimiter,ipBucket,hashPassword,verifyPassword,totpCode,verifyTotp,base32Decode,base32Encode,normalizePermissions,fullPermissions} from '../server/security.js';

test('TOTP matches RFC 6238 vectors and rejects replays',()=>{
  const secret=base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(),'12345678901234567890');
  assert.equal(totpCode(secret,Math.floor(59/30)),'287082');
  assert.equal(totpCode(secret,Math.floor(1111111109/30)),'081804');
  const now=1111111109*1000,step=Math.floor(now/30000);
  assert.equal(verifyTotp(secret,'081804',{now}),step);
  assert.equal(verifyTotp(secret,'081804',{now,lastCounter:step}),null);
  assert.equal(verifyTotp(secret,'000000',{now}),null);
  assert.equal(verifyTotp(secret,'abc',{now}),null);
});

test('login limiter separates IPs and accounts',()=>{
  const limiter=createLoginLimiter({perIp:5,perAccountIp:3,perAccount:8});
  for(let i=0;i<3;i++)limiter.fail('1.1.1.1','boss@x');
  assert.ok(limiter.blocked('1.1.1.1','boss@x')>0,'same IP and account is blocked');
  assert.equal(limiter.blocked('2.2.2.2','boss@x'),0,'the real owner from another IP can still sign in');
  limiter.fail('1.1.1.1','a@x');limiter.fail('1.1.1.1','b@x');
  assert.ok(limiter.blocked('1.1.1.1','c@x')>0,'password spraying from one IP is blocked');
  for(let i=0;i<8;i++)limiter.fail(`10.0.0.${i}`,'victim@x');
  assert.ok(limiter.blocked('9.9.9.9','victim@x')>0,'distributed guessing against one account is capped');
  assert.equal(limiter.blocked('9.9.9.9','victim@x',{trusted:true}),0,'a browser that signed in before is not locked out by the account cap');
  for(let i=0;i<3;i++)limiter.fail('8.8.8.8','victim@x');
  assert.ok(limiter.blocked('8.8.8.8','victim@x',{trusted:true})>0,'per IP+account limit still applies to trusted devices');
});

test('limits count an IPv6 /64 as one address and keep blocked counters under a flood',async()=>{
  assert.equal(ipBucket('2001:db8:1:2:3:4:5:6'),'2001:db8:1:2::/64');
  assert.equal(ipBucket('2001:0db8:0001:0002::9'),'2001:db8:1:2::/64');
  assert.equal(ipBucket('2001:db8::1'),'2001:db8:0:0::/64');
  assert.equal(ipBucket('::ffff:203.0.113.5'),'203.0.113.5');
  assert.equal(ipBucket('203.0.113.5'),'203.0.113.5');
  const limiter=createLoginLimiter({perIp:100,perAccountIp:3,perAccount:5,maxEntries:40});
  for(let i=1;i<=3;i++)limiter.fail(`2001:db8:1:2::${i}`,'boss@x');
  assert.ok(limiter.blocked('2001:db8:1:2::ffff','boss@x')>0,'rotating addresses inside one /64 does not reset the limit');
  assert.equal(limiter.blocked('2001:db8:1:3::1','boss@x'),0,'another /64 is a different address');
  for(let i=0;i<5;i++)limiter.fail(`198.51.100.${i}`,'victim@x');
  for(let i=0;i<200;i++)limiter.fail(`203.0.113.${i%250}`,`spray${i}@x`);
  assert.ok(limiter.blocked('192.0.2.1','victim@x')>0,'a flood of new entries does not wipe a counter that is at its limit');
  const form=createRateLimiter({limit:5,windowMs:600000});
  for(let i=0;i<5;i++)assert.equal(form.hit('a',1000+i),0);
  assert.ok(form.hit('a',2000)>0);
  assert.equal(form.hit('b',2000),0);
  assert.equal(form.hit('a',1000+600000),0,'the window slides');
  assert.ok(await verifyPassword('correct horse',await hashPassword('correct horse')));
  assert.equal(await verifyPassword('wrong',await hashPassword('correct horse')),false);
  assert.equal(await verifyPassword('x','broken'),false);
});

test('permission normalization fills gaps from the given base',()=>{
  assert.equal(normalizePermissions({}).deal.export,false);
  assert.equal(normalizePermissions({deal:{export:true}}).deal.export,true);
  assert.equal(normalizePermissions({},fullPermissions()).contact.delete,true);
});

test('account lifecycle, 2FA, default rights, audit log, quotas and purge',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'opencrm-hardening-'));
  process.env.PGLITE_DIR=join(folder,'pg');
  process.env.UPLOAD_DIR=join(folder,'uploads');
  process.env.NODE_ENV='test';
  process.env.ATTACHMENT_USER_QUOTA_MB='0.001';
  const {app,db}=await import('../server/index.js');
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const call=async(path,{method='GET',body,cookie,headers={}}={})=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body)});
    const data=response.headers.get('content-type')?.includes('json')?await response.json():await response.text();
    return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  };
  const login=async(email,password,code)=>call('/login',{method:'POST',body:{email,password,...(code?{code}:{})}});
  try{
    const setup=await call('/setup',{method:'POST',body:{name:'Admin',email:'admin@example.test',password:'admin-password-1'}});
    const admin=setup.cookie;
    assert.match(setup.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.equal(setup.headers.get('x-frame-options'),'DENY');

    // New members get create/edit only; delete and export need an explicit grant.
    const created=await call('/users',{method:'POST',cookie:admin,body:{name:'Manager',email:'manager@example.test',password:'manager-password',role:'member'}});
    assert.equal(created.status,201);
    assert.equal(created.data.permissions.deal.export,false);
    assert.equal(created.data.permissions.deal.delete,false);
    assert.equal(created.data.permissions.contact.create,true);
    let manager=(await login('manager@example.test','manager-password')).cookie;
    const second=(await login('manager@example.test','manager-password')).cookie;
    assert.equal((await call('/export/deals.csv',{cookie:manager})).status,403);
    assert.equal((await call('/export/contacts.csv',{cookie:manager})).status,403);
    const contact=await call('/contacts',{method:'POST',cookie:manager,body:{name:'Client'}});
    assert.equal(contact.status,201);
    assert.equal((await call('/contacts/'+contact.data.id,{method:'DELETE',cookie:manager})).status,403);

    // Lead rejection requires the same right as accepting a lead.
    const pipeline=(await call('/pipelines',{cookie:admin})).data[0];
    const lead=await call('/inbox',{method:'POST',cookie:admin,body:{pipeline_id:pipeline.id,title:'Lead',contact_name:'Lead person'}});
    await call('/users/'+created.data.id,{method:'PATCH',cookie:admin,body:{name:'Manager',email:'manager@example.test',role:'member',permissions:{deal:{create:false}}}});
    assert.equal((await call(`/inbox/${lead.data.id}/reject`,{method:'POST',cookie:manager})).status,403);
    assert.equal((await call(`/inbox/${lead.data.id}/reject`,{method:'POST',cookie:admin})).status,200);

    // Own password change keeps this session and ends the others.
    assert.equal((await call('/me/password',{method:'POST',cookie:manager,body:{current_password:'wrong-password',new_password:'manager-password-2'}})).status,403);
    const changed=await call('/me/password',{method:'POST',cookie:manager,body:{current_password:'manager-password',new_password:'manager-password-2'}});
    assert.equal(changed.status,200);
    assert.equal(changed.data.revoked_sessions,1);
    assert.equal((await call('/me',{cookie:manager})).status,200);
    assert.equal((await call('/me',{cookie:second})).status,401);
    assert.equal((await login('manager@example.test','manager-password')).status,401);

    // Admin reset ends every session of the employee.
    const reset=await call(`/users/${created.data.id}/password`,{method:'POST',cookie:admin,body:{password:'reset-password-3'}});
    assert.equal(reset.status,200);
    assert.equal((await call('/me',{cookie:manager})).status,401);
    manager=(await login('manager@example.test','reset-password-3')).cookie;
    assert.ok(manager);

    // 2FA: enrol, then sign-in needs the code; replaying the same code fails.
    const setup2fa=await call('/me/2fa/setup',{method:'POST',cookie:manager,body:{current_password:'reset-password-3'}});
    assert.equal(setup2fa.status,200);
    assert.match(setup2fa.data.otpauth_url,/^otpauth:\/\/totp\//);
    const step=Math.floor(Date.now()/30000);
    assert.equal((await call('/me/2fa/enable',{method:'POST',cookie:manager,body:{code:'000000'===totpCode(setup2fa.data.secret,step)?'111111':'000000'}})).status,400);
    assert.equal((await call('/me/2fa/enable',{method:'POST',cookie:manager,body:{code:totpCode(setup2fa.data.secret,step)}})).status,200);
    const needsCode=await login('manager@example.test','reset-password-3');
    assert.equal(needsCode.status,401);
    assert.equal(needsCode.data.totp_required,true);
    assert.equal((await login('manager@example.test','reset-password-3',totpCode(setup2fa.data.secret,step))).status,401,'a code used for enrolment cannot be replayed');
    const withCode=await login('manager@example.test','reset-password-3',totpCode(setup2fa.data.secret,step+1));
    assert.equal(withCode.status,200);
    assert.equal(withCode.data.totp_enabled,true);
    assert.equal((await call(`/users/${created.data.id}/reset-2fa`,{method:'POST',cookie:admin})).status,200);
    assert.equal((await call('/me',{cookie:withCode.cookie})).status,401);
    manager=(await login('manager@example.test','reset-password-3')).cookie;
    assert.ok(manager,'after an admin reset the password alone works again');

    // Disabling ends sessions and blocks sign-in; the last admin is protected.
    assert.equal((await call(`/users/${setup.data.id}/disable`,{method:'POST',cookie:admin})).status,409);
    const disabled=await call(`/users/${created.data.id}/disable`,{method:'POST',cookie:admin});
    assert.equal(disabled.status,200);
    assert.equal((await call('/me',{cookie:manager})).status,401);
    assert.equal((await login('manager@example.test','reset-password-3')).status,401);
    assert.equal((await call('/users',{cookie:admin})).data.find(user=>user.id===created.data.id).disabled,true);
    assert.equal((await call(`/users/${created.data.id}/enable`,{method:'POST',cookie:admin})).status,200);
    manager=(await login('manager@example.test','reset-password-3')).cookie;
    assert.ok(manager);

    // Attachment quota per user.
    await call('/users/'+created.data.id,{method:'PATCH',cookie:admin,body:{name:'Manager',email:'manager@example.test',role:'member',permissions:{contact:{edit:true}}}});
    const upload=(cookie,size)=>call('/attachments/contact/'+contact.data.id,{method:'POST',cookie,body:Buffer.alloc(size,1),headers:{'Content-Type':'application/octet-stream','x-file-name':'a.bin'}});
    assert.equal((await upload(manager,800)).status,201);
    assert.equal((await upload(manager,800)).status,413);

    // Permanent deletion removes the record, its files and its history.
    const files=readdirSync(process.env.UPLOAD_DIR);
    assert.equal(files.length,1);
    assert.equal((await call('/trash/contacts/'+contact.data.id,{method:'DELETE',cookie:admin})).status,404,'only trashed records can be purged');
    assert.equal((await call('/contacts/'+contact.data.id,{method:'DELETE',cookie:admin})).status,200);
    assert.equal((await call('/trash/contacts/'+contact.data.id,{method:'DELETE',cookie:manager})).status,403);
    assert.equal((await call('/trash/contacts/'+contact.data.id,{method:'DELETE',cookie:admin})).status,200);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM contacts WHERE id=?').get(contact.data.id)).n,0);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM entity_activity WHERE entity_type='contact' AND entity_id=?").get(contact.data.id)).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM attachments').get()).n,0);
    assert.ok(!existsSync(join(process.env.UPLOAD_DIR,files[0])));

    // Cross-site writes are rejected whatever the case of the path ('/API/...' used to slip through).
    const root=base.slice(0,-4);
    const upper=await fetch(`${root}/API/users/${created.data.id}/disable`,{method:'POST',headers:{Cookie:admin,Origin:'https://evil.example','Content-Type':'application/x-www-form-urlencoded'},body:'x=1'});
    assert.equal(upper.status,403);
    assert.equal((await db.prepare('SELECT disabled_at FROM users WHERE id=?').get(created.data.id)).disabled_at,null);
    assert.equal((await fetch(`${root}/API/me`,{headers:{Cookie:admin}})).status,404,'API routes are case-sensitive');

    // Accepting a lead never links (or reveals) contacts and companies the employee cannot see.
    const scopedRights={create:true,edit:true,delete:false,export:false};
    await call('/users',{method:'POST',cookie:admin,body:{name:'Scoped',email:'scoped@example.test',password:'scoped-password',role:'member',deal_access:'own',contact_access:'own',company_access:'own',permissions:{deal:scopedRights,contact:scopedRights,company:scopedRights}}});
    const scoped=(await login('scoped@example.test','scoped-password')).cookie;
    const hiddenCompany=(await call('/companies',{method:'POST',cookie:admin,body:{name:'Hidden Corp'}})).data.id;
    const hiddenContact=(await call('/contacts',{method:'POST',cookie:admin,body:{name:'Hidden Person',email:'hidden@corp.test',company_id:hiddenCompany}})).data.id;
    const probeLead=(await call('/inbox',{method:'POST',cookie:scoped,body:{pipeline_id:pipeline.id,title:'Probe',email:'HIDDEN@corp.test',company_name:'hidden corp'}})).data.id;
    const accepted=await call(`/inbox/${probeLead}/accept`,{method:'POST',cookie:scoped,body:{stage_id:(await call('/stages?pipeline_id='+pipeline.id,{cookie:admin})).data[0].id}});
    assert.equal(accepted.status,200);
    const acceptedDeal=await db.prepare('SELECT contact_id,company_id FROM deals WHERE id=?').get(accepted.data.deal_id);
    assert.notEqual(acceptedDeal.contact_id,hiddenContact);
    assert.notEqual(acceptedDeal.company_id,hiddenCompany);
    assert.ok(!JSON.stringify((await call('/deals/'+accepted.data.deal_id,{cookie:scoped})).data).includes('Hidden'));

    // CSV import size is capped.
    process.env.IMPORT_MAX_ROWS='3';
    assert.equal((await call('/import/companies.csv',{method:'POST',cookie:admin,body:{csv:['name','a','b','c','d'].join('\n')}})).status,413);
    assert.equal((await call('/import/companies.csv',{method:'POST',cookie:admin,body:{csv:['name','a','b','c'].join('\n')}})).data.imported,3);
    delete process.env.IMPORT_MAX_ROWS;

    // Failing logins from many addresses cannot lock the owner out of a browser they signed in from before.
    await call('/users',{method:'POST',cookie:admin,body:{name:'Victim',email:'victim@example.test',password:'victim-password',role:'member'}});
    const loginFrom=(ip,password,extra={})=>fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':ip,...extra},body:JSON.stringify({email:'victim@example.test',password})});
    const first=await loginFrom('198.51.100.1','victim-password');
    assert.equal(first.status,200);
    const device=first.headers.getSetCookie().find(item=>item.startsWith('opencrm_device='))?.split(';')[0];
    assert.ok(device,'a trusted-device cookie is issued on sign-in');
    for(let ipIndex=0;ipIndex<5;ipIndex++)for(let attempt=0;attempt<10;attempt++)assert.equal((await loginFrom(`203.0.113.${ipIndex+10}`,'guess-'+attempt)).status,401);
    assert.equal((await loginFrom('198.51.100.9','victim-password')).status,429,'a new browser is still held back while the account is under attack');
    assert.equal((await loginFrom('198.51.100.9','victim-password',{Cookie:device})).status,200,'the owner signs in from their known browser');

    // Contact list presets stay fast on large data (they used to be quadratic and block the server).
    await db.exec("INSERT INTO contacts (id,name,owner_id) OVERRIDING SYSTEM VALUE SELECT 100000+i,'Bulk contact '||i,1 FROM generate_series(0,4999) i; INSERT INTO companies (id,name,owner_id) OVERRIDING SYSTEM VALUE SELECT 100000+i,'Bulk company '||i,1 FROM generate_series(0,4999) i; INSERT INTO deals (id,name,stage_id,contact_id,company_id,owner_id) OVERRIDING SYSTEM VALUE SELECT 100000+i,'Bulk deal '||i,1,100000+i,100000+i,1 FROM generate_series(0,4999) i; INSERT INTO tasks (title,deal_id,owner_id) SELECT 'Bulk task '||i,100000+i,1 FROM generate_series(1,4999,2) i; ANALYZE");
    for(const preset of ['no_tasks','overdue','no_deals']){
      const started=Date.now(),list=await call(`/entity-list?kind=all&page_size=25&preset=${preset}`,{cookie:admin});
      assert.equal(list.status,200);
      assert.ok(Date.now()-started<1500,`${preset} took ${Date.now()-started} ms`);
    }

    // Everything above left a trail in the audit log, visible to admins only.
    assert.equal((await call('/audit-log',{cookie:manager})).status,403);
    const log=(await call('/audit-log?page_size=100',{cookie:admin})).data.items.map(item=>item.action);
    for(const action of ['auth.setup','auth.login','auth.login_failed','user.created','user.updated','auth.password_changed','user.password_reset','auth.2fa_enabled','user.2fa_reset','user.disabled','user.enabled','inbox.rejected','record.purged'])assert.ok(log.includes(action),action);
    const filtered=(await call('/audit-log?action=user',{cookie:admin})).data.items;
    assert.ok(filtered.length>0&&filtered.every(item=>item.action.startsWith('user.')));

    // A malformed cookie is treated as signed out instead of crashing the request.
    assert.equal((await call('/me',{cookie:'opencrm_session=%E0%A4%A'})).status,401);
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await db.close();
    rmSync(folder,{recursive:true,force:true});
  }
});
