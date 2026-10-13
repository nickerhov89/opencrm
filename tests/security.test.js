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
  process.env.DATABASE_PATH=join(folder,'crm.db');
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
    for(let attempt=0;attempt<20;attempt++){
      response=await post('/login',{email:'admin@example.test',password:'wrong-password'});
      assert.equal(response.status,401);
    }
    response=await post('/login',{email:'admin@example.test',password:'secure-test-password'});
    assert.equal(response.status,429);
    assert.ok(Number(response.headers.get('retry-after'))>0);
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    db.close();
    rmSync(folder,{recursive:true,force:true});
  }
});
