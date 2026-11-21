import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {quoteCsvCell} from '../server/csv.js';

test('CSV export neutralizes spreadsheet formulas in user-provided cells',()=>{
  assert.equal(quoteCsvCell('=HYPERLINK("https://example.test")'),'"\'=HYPERLINK(""https://example.test"")"');
  assert.equal(quoteCsvCell('  +SUM(1,2)'),'"\'+SUM(1,2)"');
  assert.equal(quoteCsvCell('Regular "client"'),'"Regular ""client"""');
});

test('cross-origin writes are rejected and repeated login failures are throttled',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'opencrm-security-'));
  process.env.PGLITE_DIR=join(folder,'pg');
  process.env.UPLOAD_DIR=join(folder,'uploads');
  process.env.NODE_ENV='test';
  const {app,db}=await import('../server/index.js');
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='';
  const post=async(path,body,headers={})=>fetch(`${base}/api${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},body:JSON.stringify(body)});
  try{
    let response=await post('/setup',{name:'Admin',email:'admin@example.test',password:'secure-test-password'});
    assert.equal(response.status,200);
    cookie=response.headers.get('set-cookie').split(';')[0];
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    response=await post('/login',{email:'admin@example.test',password:'secure-test-password'},{Origin:'https://evil.example'});
    assert.equal(response.status,403);
    response=await post('/login',{email:'admin@example.test',password:'secure-test-password'},{'Sec-Fetch-Site':'same-site'});
    assert.equal(response.status,403);
    response=await post('/login',{email:'admin@example.test',password:'secure-test-password'},{Origin:base});
    assert.equal(response.status,200);
    for(let attempt=0;attempt<10;attempt++){
      response=await post('/login',{email:'admin@example.test',password:'wrong-password'});
      assert.equal(response.status,401);
    }
    response=await post('/login',{email:'admin@example.test',password:'secure-test-password'});
    assert.equal(response.status,429);
    assert.ok(Number(response.headers.get('retry-after'))>0);

    // A POST without a JSON body is a validation error, not a server error.
    const empty=await fetch(`${base}/api/login`,{method:'POST'});
    assert.equal(empty.status,401);

    // Public lead form: five accepted submissions per address in ten minutes, across all forms;
    // a submission refused for missing contacts is not counted, other addresses are not affected.
    const formRes=await post('/pipelines/1/forms',{title:'Site'});
    assert.equal(formRes.status,201);
    const {token}=await formRes.json();
    const secondToken=(await (await post('/pipelines/1/forms',{title:'Landing'})).json()).token;
    const submit=(formToken,body,ip='198.51.100.20')=>fetch(`${base}/api/public/forms/${formToken}`,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':ip},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal((await fetch(`${base}/api/public/forms/${token}`,{method:'POST'})).status,400,'empty submission is rejected without a server error');
    for(let index=0;index<3;index++)assert.equal((await submit(token,{message:'no contacts'})).status,400);
    for(let index=0;index<5;index++)assert.equal((await submit(index%2?secondToken:token,{contact_name:`Lead ${index}`,phone:'+70000000000'})).status,201);
    const limited=await submit(secondToken,{contact_name:'Lead 6',phone:'+70000000000'});
    assert.equal(limited.status,429);
    assert.ok(Number(limited.headers.get('retry-after'))>0);
    assert.equal((await submit(token,{contact_name:'Bot',website_hidden:'x'})).status,429,'honeypot submissions share the limit');
    assert.equal((await submit(token,{contact_name:'Other visitor',phone:'+70000000001'},'198.51.100.21')).status,201);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM inbox_leads WHERE source LIKE 'Форма:%'").get()).n,6);
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await db.close();
    rmSync(folder,{recursive:true,force:true});
  }
});
