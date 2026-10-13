import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.js';
import { parseCsv, quoteCsvCell } from './csv.js';
import { registerIntegrations } from './integrations.js';
import {defaultDealCardFields,validDealCardFields} from '../src/deal-card-layout.js';

const app = express();
const db = createDb();
db.function('has_entity_tag',{deterministic:true},(raw,wanted)=>String(raw||'').split(',').some(tag=>tag.trim().toLocaleLowerCase('ru-RU')===String(wanted||'').trim().toLocaleLowerCase('ru-RU'))?1:0);
db.function('contains_search',{deterministic:true},(raw,wanted)=>String(raw||'').toLocaleLowerCase('ru-RU').includes(String(wanted||'').toLocaleLowerCase('ru-RU'))?1:0);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const uploadDir = resolve(process.env.UPLOAD_DIR || resolve(root,'data/uploads'));
mkdirSync(uploadDir,{recursive:true});
app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','strict-origin-when-cross-origin');
  if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store');
  if(!req.path.startsWith('/api/')||['GET','HEAD','OPTIONS'].includes(req.method))return next();
  const origin=req.get('origin'),referer=req.get('referer');
  const source=origin||referer;
  if(source){
    try{if(new URL(source).host!==req.get('host'))return res.status(403).json({error:'Запрос с другого сайта отклонён'})}
    catch{return res.status(403).json({error:'Неверный Origin'})}
  }
  if(['cross-site','same-site'].includes(req.get('sec-fetch-site')))return res.status(403).json({error:'Запрос с другого сайта отклонён'});
  next();
});
app.use(express.json({ limit: '1mb' }));

const fail = (res, code, message) => res.status(code).json({ error: message });
const hashPassword = password => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; };
const verifyPassword = (password, stored) => { const [salt, hash] = stored.split(':'); if (!salt || !hash) return false; const computed = scryptSync(password,salt,64); const saved = Buffer.from(hash,'hex'); return saved.length === computed.length && timingSafeEqual(saved,computed); };
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const loginFailures=new Map();
const loginWindowMs=15*60*1000;
const loginLimit=20;
const loginKey=email=>tokenHash(email);
const loginState=email=>{const key=loginKey(email),state=loginFailures.get(key);if(state&&state.until>Date.now())return {key,state};loginFailures.delete(key);return {key,state:null}};
const recordLoginFailure=(key,state)=>{if(loginFailures.size>=10000){for(const [entry,item] of loginFailures)if(item.until<=Date.now())loginFailures.delete(entry);if(loginFailures.size>=10000)loginFailures.delete(loginFailures.keys().next().value)}const next={count:(state?.count||0)+1,until:state?.until||Date.now()+loginWindowMs};loginFailures.set(key,next);return next};
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(([k,v]) => k && v));
const setSession = (res, userId) => { const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(tokenHash(token),userId,Date.now()+30*864e5); res.setHeader('Set-Cookie',`opencrm_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`); };
const permissionEntities=['deal','contact','company','task'];
const permissionActions=['create','edit','delete','export'];
const parsePermissions=raw=>{try{return JSON.parse(raw||'{}')}catch{return {}}};
const validPermissions=permissions=>permissions&&typeof permissions==='object'&&!Array.isArray(permissions)&&Object.keys(permissions).every(entity=>permissionEntities.includes(entity)&&permissions[entity]&&typeof permissions[entity]==='object'&&!Array.isArray(permissions[entity])&&Object.entries(permissions[entity]).every(([action,allowed])=>permissionActions.includes(action)&&typeof allowed==='boolean'));
const allowed=(req,entity,action)=>req.user.role==='admin'||req.user.permissions?.[entity]?.[action]!==false;
const requirePermission=(entity,action)=>(req,res,next)=>allowed(req,entity,action)?next():fail(res,403,'Нет прав на это действие');
const auth = (req,res,next) => { const token = cookies(req).opencrm_session; const row = token && db.prepare('SELECT u.id,u.name,u.email,u.role,u.deal_access,u.task_access,u.contact_access,u.company_access,u.group_id,u.permissions_json FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash(token),Date.now()); if (!row) return fail(res,401,'Нужен вход в систему'); req.user={...row,permissions:parsePermissions(row.permissions_json)};delete req.user.permissions_json;next(); };
const admin = (req,res,next) => req.user.role === 'admin' ? next() : fail(res,403,'Нужны права администратора');
const required = (v,max=255) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
const value = (v,max=1000) => typeof v === 'string' ? v.trim().slice(0,max) : '';
const int = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const amount = v => Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const lossReason = v => typeof v === 'string' && v.trim().length <= 120 ? v.trim() : null;
const stageKind = id => db.prepare('SELECT kind FROM stages WHERE id=?').get(id)?.kind;
const idExists = (table,id) => id && db.prepare(`SELECT id FROM ${table} WHERE id=?${['contacts','companies'].includes(table)?' AND deleted_at IS NULL':''}`).get(id);
const ownDeals=req=>req.user.role!=='admin'&&req.user.deal_access==='own';
const ownTasks=req=>req.user.role!=='admin'&&req.user.task_access==='own';
const ownContacts=req=>req.user.role!=='admin'&&req.user.contact_access==='own';
const ownCompanies=req=>req.user.role!=='admin'&&req.user.company_access==='own';
const entityAllowed=(req,type,id)=>{const table=type==='contact'?'contacts':'companies',own=type==='contact'?ownContacts(req):ownCompanies(req);return !!id&&!!db.prepare(`SELECT id FROM ${table} WHERE id=? AND deleted_at IS NULL AND (?=0 OR owner_id=?)`).get(id,own?1:0,req.user.id)};
const linkedEntityAllowed=(req,contactId,companyId)=>(!contactId||entityAllowed(req,'contact',contactId))&&(!companyId||entityAllowed(req,'company',companyId));
const liveDeal=id=>db.prepare('SELECT id,owner_id FROM deals WHERE id=? AND deleted_at IS NULL').get(id);
const dealAllowed=(req,id)=>{const deal=liveDeal(id);return !!deal&&(!ownDeals(req)||deal.owner_id===req.user.id)};
const taskAllowed=(req,task)=>!ownTasks(req)||task.owner_id===req.user.id;
const taskSchedule=(input)=>{const raw=input.due_at,duration=Number(input.duration_minutes??0),allDay=input.all_day===true||input.all_day===1?1:input.all_day===false||input.all_day===0||input.all_day==null?0:null;if(allDay===null||!Number.isInteger(duration)||duration<0||duration>1440||raw!=null&&raw!==''&&(typeof raw!=='string'||raw.length>40||!Number.isFinite(Date.parse(raw)))||allDay&&(!raw||raw==='')||duration>0&&(!raw||raw===''))return null;return {due_at:raw&&raw!==''?new Date(raw).toISOString():null,duration_minutes:allDay?0:duration,all_day:allDay}};
const event = (dealId,userId,text) => db.prepare('INSERT INTO activity (deal_id,user_id,event) VALUES (?,?,?)').run(dealId,userId,text);
const entityEvent=(type,id,userId,text)=>db.prepare('INSERT INTO entity_activity (entity_type,entity_id,user_id,event) VALUES (?,?,?,?)').run(type,id,userId,text);
const entityFieldLabels={name:'Название',owner_id:'Ответственный',company_id:'Компания',position:'Должность',website:'Сайт',address:'Адрес',phone:'Телефон',email:'Email',tags:'Теги',notes:'Примечание'};
const entityFieldValue=(field,raw)=>{
  if(raw==null||raw==='')return '—';
  if(field==='owner_id')return db.prepare('SELECT name FROM users WHERE id=?').get(raw)?.name||'—';
  if(field==='company_id')return db.prepare('SELECT name FROM companies WHERE id=?').get(raw)?.name||'—';
  if(field==='contact_id')return db.prepare('SELECT name FROM contacts WHERE id=?').get(raw)?.name||'—';
  return String(raw).replace(/[\r\n\t]+/g,' ').slice(0,160);
};
const logEntityChanges=(type,id,userId,old,saved)=>{
  for(const [field,label] of Object.entries(entityFieldLabels)){
    if(!(field in saved)||String(old[field]??'')===String(saved[field]??''))continue;
    entityEvent(type,id,userId,`Поле «${label}»: ${entityFieldValue(field,old[field])} → ${entityFieldValue(field,saved[field])}`);
  }
};
const dealFieldLabels={name:'Название',owner_id:'Ответственный',amount:'Бюджет',contact_id:'Контакт',company_id:'Компания',source:'Источник',tags:'Теги',description:'Описание'};
const dealFieldValue=(field,raw)=>field==='amount'?`${new Intl.NumberFormat('ru-RU').format(Number(raw)||0)} ₽`:entityFieldValue(field,raw);
const logDealChanges=(id,userId,old,saved)=>{
  for(const [field,label] of Object.entries(dealFieldLabels)){
    const before=['owner_id','contact_id','company_id'].includes(field)?Number(old[field])||0:String(old[field]??'');
    const after=['owner_id','contact_id','company_id'].includes(field)?Number(saved[field])||0:String(saved[field]??'');
    if(before===after)continue;
    event(id,userId,`Поле «${label}»: ${dealFieldValue(field,old[field])} → ${dealFieldValue(field,saved[field])}`);
  }
};
const parseTags=input=>{const unique=new Map();for(const raw of input.split(',')){const tag=raw.trim(),key=tag.toLocaleLowerCase('ru');if(tag&&!unique.has(key))unique.set(key,tag)}return [...unique.values()]};
const runStageAutomation=(dealId,stageId,ownerId,userId)=>{const rule=db.prepare('SELECT task_title,due_days FROM stage_automations WHERE stage_id=?').get(stageId);if(!rule)return;const dueDate=new Date();dueDate.setDate(dueDate.getDate()+rule.due_days);dueDate.setHours(23,59,0,0);db.prepare('INSERT INTO tasks (title,task_type,due_at,deal_id,owner_id) VALUES (?,\'Связаться\',?,?,?)').run(rule.task_title,dueDate.toISOString(),dealId,ownerId||userId);event(dealId,userId,`Автоматически создана задача «${rule.task_title}»`)};
const customTables={deal:'deals',contact:'contacts',company:'companies'};
const fieldOptions=input=>{if(!Array.isArray(input)||input.length<1||input.length>50)return null;const options=input.map(item=>typeof item==='string'?item.trim():'');if(options.some(item=>!item||item.length>120)||new Set(options.map(item=>item.toLocaleLowerCase('ru-RU'))).size!==options.length)return null;return options};
const storedOptions=field=>{try{return JSON.parse(field.options_json||'[]')}catch{return []}};
const customValueError=(field,fieldValue)=>{
  if(field.field_type==='number'&&fieldValue!==''&&!Number.isFinite(Number(fieldValue)))return 'Введите число';
  if(field.field_type==='date'&&fieldValue!==''&&!/^\d{4}-\d{2}-\d{2}$/.test(fieldValue))return 'Введите дату';
  if(field.field_type==='url'&&fieldValue!==''&&!/^https?:\/\//i.test(fieldValue))return 'Нужен адрес с http:// или https://';
  if(field.field_type==='select'&&fieldValue!==''&&!storedOptions(field).includes(fieldValue))return 'Выберите вариант из списка';
  return null;
};
const customFieldsFor=(type,id)=>db.prepare('SELECT f.*,COALESCE(v.value,\'\') value FROM custom_fields f LEFT JOIN custom_field_values v ON v.field_id=f.id AND v.entity_id=? WHERE f.entity_type=? ORDER BY f.sort_order,f.id').all(id,type);
const attachmentsFor=(type,id)=>db.prepare('SELECT a.id,a.filename,a.mime_type,a.byte_size,a.created_at,u.name author FROM attachments a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity_type=? AND a.entity_id=? ORDER BY a.id DESC').all(type,id);
const dealContactsFor=(req,id)=>db.prepare(`SELECT c.id,c.name,c.position,c.phone,c.email,c.company_id,co.name company_name FROM deal_contacts dc JOIN contacts c ON c.id=dc.contact_id AND c.deleted_at IS NULL AND (${ownContacts(req)?1:0}=0 OR c.owner_id=${req.user.id}) LEFT JOIN companies co ON co.id=c.company_id AND co.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR co.owner_id=${req.user.id}) WHERE dc.deal_id=? ORDER BY (c.id=(SELECT contact_id FROM deals WHERE id=?)) DESC,dc.created_at,c.id`).all(id,id);

app.get('/api/status', (_req,res) => res.json({ setup: db.prepare('SELECT COUNT(*) n FROM users').get().n === 0 }));
app.post('/api/setup',(req,res) => { if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return fail(res,409,'Аккаунт уже создан'); const {name,email,password}=req.body; if (!required(name,120)||!required(email,254)||!email.includes('@')||typeof password!=='string'||password.length<10) return fail(res,400,'Укажите имя, email и пароль от 10 символов'); const result=db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)').run(name.trim(),email.trim().toLowerCase(),hashPassword(password),'admin'); setSession(res,result.lastInsertRowid); res.json({id:result.lastInsertRowid,name:name.trim(),email:email.trim().toLowerCase(),role:'admin'}); });
app.post('/api/login',(req,res) => { const email=value(req.body?.email,254).toLowerCase(),{key,state}=loginState(email);if(state?.count>=loginLimit){res.set('Retry-After',String(Math.ceil((state.until-Date.now())/1000)));return fail(res,429,'Слишком много попыток входа. Повторите позже')}const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!u||typeof req.body?.password!=='string'||req.body.password.length>1024||!verifyPassword(req.body.password,u.password_hash)){recordLoginFailure(key,state);return fail(res,401,'Неверный email или пароль')}loginFailures.delete(key);setSession(res,u.id);res.json({id:u.id,name:u.name,email:u.email,role:u.role,deal_access:u.deal_access,task_access:u.task_access,contact_access:u.contact_access,company_access:u.company_access,group_id:u.group_id,permissions:parsePermissions(u.permissions_json)}); });
app.post('/api/logout',auth,(req,res) => { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(cookies(req).opencrm_session)); res.setHeader('Set-Cookie','opencrm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({ok:true}); });
app.get('/api/me',auth,(req,res) => res.json(req.user));
app.get('/api/search',auth,(req,res)=>{
  const q=value(req.query.q,120);
  if(q.length<2)return res.json({deals:[],contacts:[],companies:[]});
  const deals=db.prepare(`SELECT d.id,d.name,d.amount,p.name pipeline_name,s.name stage_name,c.name contact_name,co.name company_name
    FROM deals d JOIN stages s ON s.id=d.stage_id JOIN pipelines p ON p.id=s.pipeline_id
    LEFT JOIN contacts c ON c.id=d.contact_id AND c.deleted_at IS NULL AND (${ownContacts(req)?1:0}=0 OR c.owner_id=${req.user.id})
    LEFT JOIN companies co ON co.id=d.company_id AND co.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR co.owner_id=${req.user.id})
    WHERE d.deleted_at IS NULL AND (?=0 OR d.owner_id=?)
      AND (contains_search(d.name,?) OR contains_search(d.source,?) OR contains_search(d.tags,?) OR contains_search(c.name,?) OR contains_search(c.phone,?) OR contains_search(c.email,?)
        OR contains_search(co.name,?) OR contains_search(co.phone,?) OR contains_search(co.email,?)
        OR EXISTS(SELECT 1 FROM deal_contacts dc JOIN contacts linked ON linked.id=dc.contact_id AND linked.deleted_at IS NULL AND (${ownContacts(req)?1:0}=0 OR linked.owner_id=${req.user.id})
          WHERE dc.deal_id=d.id AND (contains_search(linked.name,?) OR contains_search(linked.phone,?) OR contains_search(linked.email,?)))
        OR EXISTS(SELECT 1 FROM custom_field_values v JOIN custom_fields f ON f.id=v.field_id AND f.entity_type='deal'
          WHERE v.entity_id=d.id AND contains_search(v.value,?)))
    ORDER BY d.updated_at DESC,d.id DESC LIMIT 8`).all(ownDeals(req)?1:0,req.user.id,...Array(13).fill(q));
  const contacts=db.prepare(`SELECT c.id,c.name,c.position,c.phone,c.email,co.name company_name FROM contacts c
    LEFT JOIN companies co ON co.id=c.company_id AND co.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR co.owner_id=${req.user.id})
    WHERE c.deleted_at IS NULL${ownContacts(req)?` AND c.owner_id=${req.user.id}`:''} AND (contains_search(c.name,?) OR contains_search(c.phone,?) OR contains_search(c.email,?) OR contains_search(c.tags,?) OR contains_search(co.name,?)
      OR EXISTS(SELECT 1 FROM custom_field_values v JOIN custom_fields f ON f.id=v.field_id AND f.entity_type='contact'
        WHERE v.entity_id=c.id AND contains_search(v.value,?)))
    ORDER BY c.name COLLATE NOCASE,c.id LIMIT 8`).all(...Array(6).fill(q));
  const companies=db.prepare(`SELECT id,name,phone,email,website FROM companies
    WHERE deleted_at IS NULL${ownCompanies(req)?` AND owner_id=${req.user.id}`:''} AND (contains_search(name,?) OR contains_search(phone,?) OR contains_search(email,?) OR contains_search(tags,?)
      OR EXISTS(SELECT 1 FROM custom_field_values v JOIN custom_fields f ON f.id=v.field_id AND f.entity_type='company'
        WHERE v.entity_id=companies.id AND contains_search(v.value,?)))
    ORDER BY name COLLATE NOCASE,id LIMIT 8`).all(...Array(5).fill(q));
  res.json({deals,contacts,companies});
});
const dealCardCustomIds=()=>db.prepare("SELECT id FROM custom_fields WHERE entity_type='deal'").all().map(row=>row.id);
app.get('/api/pipelines/:id/card-layout',auth,(req,res)=>{
  const id=int(req.params.id);
  if(!idExists('pipelines',id))return fail(res,404,'Воронка не найдена');
  const saved=db.prepare('SELECT fields_json,show_avatar FROM deal_card_layouts WHERE pipeline_id=?').get(id);
  let fields=defaultDealCardFields;
  if(saved){try{const parsed=JSON.parse(saved.fields_json);if(validDealCardFields(parsed,dealCardCustomIds()))fields=parsed}catch{}}
  res.json({pipeline_id:id,fields,show_avatar:saved?!!saved.show_avatar:true});
});
app.put('/api/pipelines/:id/card-layout',auth,admin,(req,res)=>{
  const id=int(req.params.id),fields=req.body?.fields,showAvatar=req.body?.show_avatar??true;
  if(!idExists('pipelines',id))return fail(res,404,'Воронка не найдена');
  if(!validDealCardFields(fields,dealCardCustomIds()))return fail(res,400,'Выберите от одного до семи полей сделки');
  if(typeof showAvatar!=='boolean')return fail(res,400,'Проверьте отображение аватара');
  db.prepare('INSERT INTO deal_card_layouts (pipeline_id,fields_json,show_avatar) VALUES (?,?,?) ON CONFLICT(pipeline_id) DO UPDATE SET fields_json=excluded.fields_json,show_avatar=excluded.show_avatar').run(id,JSON.stringify(fields),showAvatar?1:0);
  res.json({pipeline_id:id,fields,show_avatar:showAvatar});
});
const dealFilterKeys=['preset','name','owner','source','tag','stageIds','amountFrom','amountTo','createdFrom','createdTo'];
const validDealFilter=input=>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!dealFilterKeys.includes(key)))return false;
  const scalar=key=>typeof input[key]==='string'&&input[key].length<=255;
  if(dealFilterKeys.filter(key=>key!=='stageIds').some(key=>!scalar(key)))return false;
  if(!['','open','mine','won','lost','noTasks','overdue'].includes(input.preset))return false;
  if(!Array.isArray(input.stageIds)||input.stageIds.length>100||input.stageIds.some(id=>!int(id)))return false;
  if(input.owner&&!int(input.owner))return false;
  if(['amountFrom','amountTo'].some(key=>input[key]!==''&&(amount(input[key])===null||Number(input[key])>1e12)))return false;
  return ['createdFrom','createdTo'].every(key=>input[key]===''||/^\d{4}-\d{2}-\d{2}$/.test(input[key]));
};
app.get('/api/me/deal-filters',auth,(req,res)=>res.json(db.prepare('SELECT id,name,filter_json,created_at FROM deal_saved_filters WHERE user_id=? ORDER BY name COLLATE NOCASE,id').all(req.user.id).map(({filter_json,...row})=>({...row,filter:JSON.parse(filter_json)}))));
app.post('/api/me/deal-filters',auth,(req,res)=>{
  const name=value(req.body.name,80),filter=req.body.filter;
  if(!required(req.body.name,80)||!validDealFilter(filter))return fail(res,400,'Проверьте название и условия фильтра');
  const existing=db.prepare('SELECT id,name FROM deal_saved_filters WHERE user_id=?').all(req.user.id).find(row=>row.name.toLocaleLowerCase('ru-RU')===name.toLocaleLowerCase('ru-RU'));
  if(!existing&&db.prepare('SELECT COUNT(*) total FROM deal_saved_filters WHERE user_id=?').get(req.user.id).total>=30)return fail(res,400,'Можно сохранить не больше 30 фильтров');
  if(existing)db.prepare('UPDATE deal_saved_filters SET name=?,filter_json=? WHERE id=?').run(name,JSON.stringify(filter),existing.id);
  else db.prepare('INSERT INTO deal_saved_filters (user_id,name,filter_json) VALUES (?,?,?)').run(req.user.id,name,JSON.stringify(filter));
  const row=db.prepare('SELECT id,name,filter_json,created_at FROM deal_saved_filters WHERE id=?').get(existing?.id||db.prepare('SELECT last_insert_rowid() id').get().id);
  res.json({id:row.id,name:row.name,filter:JSON.parse(row.filter_json),created_at:row.created_at});
});
app.delete('/api/me/deal-filters/:id',auth,(req,res)=>{const result=db.prepare('DELETE FROM deal_saved_filters WHERE id=? AND user_id=?').run(int(req.params.id),req.user.id);if(!result.changes)return fail(res,404,'Фильтр не найден');res.json({ok:true})});
const defaultDealColumns=['name','contact','company','stage','amount'];
const validDealColumn=key=>['name','contact','company','stage','loss_reason','amount','owner','source','tags','created','updated','pipeline'].includes(key)||/^field:[1-9]\d*$/.test(key)&&!!int(key.slice(6))&&!!db.prepare("SELECT id FROM custom_fields WHERE id=? AND entity_type='deal'").get(Number(key.slice(6)));
app.get('/api/me/deal-columns',auth,(req,res)=>{
  const saved=db.prepare('SELECT columns_json FROM deal_list_columns WHERE user_id=?').get(req.user.id);
  let columns=defaultDealColumns;
  if(saved){try{const parsed=JSON.parse(saved.columns_json);if(Array.isArray(parsed))columns=parsed.filter(validDealColumn)}catch{}}
  res.json({columns:columns.includes('name')?columns:defaultDealColumns});
});
app.put('/api/me/deal-columns',auth,(req,res)=>{
  const columns=req.body.columns;
  if(!Array.isArray(columns)||columns.length<1||columns.length>100||!columns.includes('name')||new Set(columns).size!==columns.length||columns.some(key=>typeof key!=='string'||!validDealColumn(key)))return fail(res,400,'Проверьте колонки списка');
  db.prepare('INSERT INTO deal_list_columns (user_id,columns_json) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET columns_json=excluded.columns_json').run(req.user.id,JSON.stringify(columns));
  res.json({columns});
});
const entityColumnDefaults={contact:['name','company','owner','phone','email'],company:['name','owner','phone','email'],all:['name','company','owner','phone','email']};
const validEntityColumn=(kind,key)=>['name','company','position','owner','phone','email','website','tags','created'].includes(key)||/^field:[1-9]\d*$/.test(key)&&!!db.prepare("SELECT id FROM custom_fields WHERE id=? AND entity_type IN ('contact','company') AND (?='all' OR entity_type=?)").get(Number(key.slice(6)),kind,kind);
app.get('/api/me/entity-columns',auth,(req,res)=>{
  const kind=value(req.query.kind,20);
  if(!entityColumnDefaults[kind])return fail(res,400,'Проверьте тип списка');
  const saved=db.prepare('SELECT columns_json FROM entity_list_columns WHERE user_id=? AND kind=?').get(req.user.id,kind);
  let columns=entityColumnDefaults[kind];
  if(saved){try{const parsed=JSON.parse(saved.columns_json);if(Array.isArray(parsed))columns=parsed.filter(key=>typeof key==='string'&&validEntityColumn(kind,key))}catch{}}
  res.json({columns:columns.includes('name')?columns:entityColumnDefaults[kind]});
});
app.put('/api/me/entity-columns',auth,(req,res)=>{
  const kind=value(req.body.kind,20),columns=req.body.columns;
  if(!entityColumnDefaults[kind]||!Array.isArray(columns)||columns.length<1||columns.length>100||!columns.includes('name')||new Set(columns).size!==columns.length||columns.some(key=>typeof key!=='string'||!validEntityColumn(kind,key)))return fail(res,400,'Проверьте колонки списка');
  db.prepare('INSERT INTO entity_list_columns (user_id,kind,columns_json) VALUES (?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET columns_json=excluded.columns_json').run(req.user.id,kind,JSON.stringify(columns));
  res.json({columns});
});
app.get('/api/settings',auth,(_req,res) => res.json({name:db.prepare("SELECT value FROM app_settings WHERE key='name'").get()?.value||'OpenCRM'}));
app.patch('/api/settings',auth,admin,(req,res) => { if(!required(req.body.name,120))return fail(res,400,'Укажите название аккаунта');const name=req.body.name.trim();db.prepare("INSERT INTO app_settings (key,value) VALUES ('name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(name);res.json({name}); });
app.get('/api/user-groups',auth,(_req,res)=>res.json(db.prepare('SELECT g.id,g.name,COUNT(u.id) members FROM user_groups g LEFT JOIN users u ON u.group_id=g.id GROUP BY g.id ORDER BY g.name COLLATE NOCASE,g.id').all()));
app.post('/api/user-groups',auth,admin,(req,res)=>{const name=value(req.body.name,120);if(!required(req.body.name,120))return fail(res,400,'Укажите название группы');if(db.prepare('SELECT id FROM user_groups WHERE lower(name)=lower(?)').get(name))return fail(res,409,'Такая группа уже есть');const r=db.prepare('INSERT INTO user_groups (name) VALUES (?)').run(name);res.status(201).json({id:r.lastInsertRowid,name,members:0})});
app.patch('/api/user-groups/:id',auth,admin,(req,res)=>{const id=int(req.params.id),name=value(req.body.name,120);if(!idExists('user_groups',id))return fail(res,404,'Группа не найдена');if(!required(req.body.name,120))return fail(res,400,'Укажите название группы');if(db.prepare('SELECT id FROM user_groups WHERE lower(name)=lower(?) AND id<>?').get(name,id))return fail(res,409,'Такая группа уже есть');db.prepare('UPDATE user_groups SET name=? WHERE id=?').run(name,id);res.json({id,name})});
app.get('/api/users',auth,(_req,res) => {
  const rows=db.prepare('SELECT u.id,u.name,u.email,u.role,u.deal_access,u.task_access,u.contact_access,u.company_access,u.group_id,u.permissions_json,g.name group_name FROM users u LEFT JOIN user_groups g ON g.id=u.group_id ORDER BY u.name COLLATE NOCASE').all();
  res.json(rows.map(({permissions_json,...user})=>({...user,permissions:parsePermissions(permissions_json)})));
});
app.post('/api/users',auth,admin,(req,res) => {
  const {name,email,password,role='member',deal_access='all',task_access='all',contact_access='all',company_access='all'}=req.body,group=int(req.body.group_id),permissions=req.body.permissions??{};
  if(!required(name,120)||!required(email,254)||!email.includes('@')||typeof password!=='string'||password.length<10||!['admin','member'].includes(role)||!['all','own'].includes(deal_access)||!['all','own'].includes(task_access)||!['all','own'].includes(contact_access)||!['all','own'].includes(company_access)||group&&!idExists('user_groups',group)||!validPermissions(permissions))return fail(res,400,'Проверьте данные сотрудника');
  try{const result=db.prepare('INSERT INTO users (name,email,password_hash,role,deal_access,task_access,contact_access,company_access,group_id,permissions_json) VALUES (?,?,?,?,?,?,?,?,?,?)').run(name.trim(),email.trim().toLowerCase(),hashPassword(password),role,deal_access,task_access,contact_access,company_access,group,JSON.stringify(permissions));res.status(201).json({id:result.lastInsertRowid,name:name.trim(),email:email.trim().toLowerCase(),role,deal_access,task_access,contact_access,company_access,group_id:group,permissions})}
  catch(error){if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return fail(res,409,'Email уже используется');throw error}
});
app.patch('/api/users/:id',auth,admin,(req,res)=>{
  const id=int(req.params.id),old=db.prepare('SELECT id,role,deal_access,task_access,contact_access,company_access,group_id,permissions_json FROM users WHERE id=?').get(id);
  if(!old)return fail(res,404,'Сотрудник не найден');
  const {name,email,role}=req.body,dealAccess=req.body.deal_access??old.deal_access,taskAccess=req.body.task_access??old.task_access,contactAccess=req.body.contact_access??old.contact_access,companyAccess=req.body.company_access??old.company_access,group=int(Object.hasOwn(req.body,'group_id')?req.body.group_id:old.group_id),permissions=req.body.permissions??parsePermissions(old.permissions_json);
  if(!required(name,120)||!required(email,254)||!email.includes('@')||!['admin','member'].includes(role)||!['all','own'].includes(dealAccess)||!['all','own'].includes(taskAccess)||!['all','own'].includes(contactAccess)||!['all','own'].includes(companyAccess)||group&&!idExists('user_groups',group)||!validPermissions(permissions))return fail(res,400,'Проверьте данные сотрудника');
  if(old.role==='admin'&&role!=='admin'&&db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n<=1)return fail(res,409,'Нельзя убрать последнего администратора');
  try{db.prepare('UPDATE users SET name=?,email=?,role=?,deal_access=?,task_access=?,contact_access=?,company_access=?,group_id=?,permissions_json=? WHERE id=?').run(name.trim(),email.trim().toLowerCase(),role,dealAccess,taskAccess,contactAccess,companyAccess,group,JSON.stringify(permissions),id);res.json({id,name:name.trim(),email:email.trim().toLowerCase(),role,deal_access:dealAccess,task_access:taskAccess,contact_access:contactAccess,company_access:companyAccess,group_id:group,permissions})}
  catch(error){if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return fail(res,409,'Email уже используется');throw error}
});
app.get('/api/custom-fields',auth,(req,res)=>{const type=value(req.query.entity_type,20);if(type&&!customTables[type])return fail(res,400,'Неизвестный тип записи');res.json(type?db.prepare('SELECT * FROM custom_fields WHERE entity_type=? ORDER BY sort_order,id').all(type):db.prepare('SELECT * FROM custom_fields ORDER BY entity_type,sort_order,id').all());});
app.post('/api/custom-fields',auth,admin,(req,res)=>{const {entity_type,field_type}=req.body;const name=value(req.body.name,120),options=field_type==='select'?fieldOptions(req.body.options):[];if(!customTables[entity_type]||!['text','number','date','url','select'].includes(field_type)||!name||options===null)return fail(res,400,'Проверьте поле и варианты');if(db.prepare('SELECT id FROM custom_fields WHERE entity_type=? AND lower(name)=lower(?)').get(entity_type,name))return fail(res,409,'Поле с таким названием уже есть');const order=db.prepare('SELECT COUNT(*) n FROM custom_fields WHERE entity_type=?').get(entity_type).n;const optionsJson=JSON.stringify(options);const result=db.prepare('INSERT INTO custom_fields (entity_type,name,field_type,options_json,sort_order) VALUES (?,?,?,?,?)').run(entity_type,name,field_type,optionsJson,order);res.status(201).json({id:result.lastInsertRowid,entity_type,name,field_type,options_json:optionsJson,sort_order:order});});
app.patch('/api/custom-fields/:id',auth,admin,(req,res)=>{const id=int(req.params.id),old=db.prepare('SELECT * FROM custom_fields WHERE id=?').get(id);if(!old)return fail(res,404,'Поле не найдено');const name=value(req.body.name,120);if(!name)return fail(res,400,'Укажите название поля');if(db.prepare('SELECT id FROM custom_fields WHERE entity_type=? AND lower(name)=lower(?) AND id<>?').get(old.entity_type,name,id))return fail(res,409,'Поле с таким названием уже есть');const options=old.field_type==='select'&&req.body.options!==undefined?fieldOptions(req.body.options):storedOptions(old);if(options===null)return fail(res,400,'Проверьте варианты');if(old.field_type==='select'&&db.prepare('SELECT DISTINCT value FROM custom_field_values WHERE field_id=? AND value<>\'\'').all(id).some(row=>!options.includes(row.value)))return fail(res,400,'Нельзя удалить вариант, который уже используется');const optionsJson=JSON.stringify(options);db.prepare('UPDATE custom_fields SET name=?,options_json=? WHERE id=?').run(name,optionsJson,id);res.json({...old,name,options_json:optionsJson})});
app.put('/api/custom-fields/:id/values/:entity_id',auth,(req,res)=>{const field=db.prepare('SELECT * FROM custom_fields WHERE id=?').get(int(req.params.id)),entityId=int(req.params.entity_id);if(!field||!idExists(customTables[field.entity_type],entityId))return fail(res,404,'Запись или поле не найдены');if(!allowed(req,field.entity_type,'edit'))return fail(res,403,'Нет прав на это действие');if(field.entity_type==='deal'&&!dealAllowed(req,entityId))return fail(res,403,'Нет доступа к сделке');if(field.entity_type!=='deal'&&!entityAllowed(req,field.entity_type,entityId))return fail(res,403,'Нет доступа к записи');if(typeof req.body.value!=='string'||req.body.value.length>1000)return fail(res,400,'Значение слишком длинное');const fieldValue=req.body.value.trim();const valueError=customValueError(field,fieldValue);if(valueError)return fail(res,400,valueError);const previous=db.prepare('SELECT value FROM custom_field_values WHERE field_id=? AND entity_id=?').get(field.id,entityId)?.value||'';db.transaction(()=>{db.prepare('INSERT INTO custom_field_values (field_id,entity_id,value) VALUES (?,?,?) ON CONFLICT(field_id,entity_id) DO UPDATE SET value=excluded.value').run(field.id,entityId,fieldValue);if(previous!==fieldValue){if(field.entity_type==='deal')event(entityId,req.user.id,`Поле «${field.name}» изменено`);else entityEvent(field.entity_type,entityId,req.user.id,`Поле «${field.name}»: ${entityFieldValue('custom',previous)} → ${entityFieldValue('custom',fieldValue)}`)}})();res.json({ok:true,value:fieldValue});});
app.post('/api/entities/bulk',auth,(req,res)=>{
  const {kind,ids,action}=req.body;
  if(!['contact','company'].includes(kind)||!['owner','tags'].includes(action)||!Array.isArray(ids)||ids.length<1||ids.length>500||ids.some(id=>!int(id))||new Set(ids.map(Number)).size!==ids.length)return fail(res,400,'Проверьте записи и действие');
  if(!allowed(req,kind,'edit'))return fail(res,403,'Нет прав на это действие');
  const table=customTables[kind],rows=db.prepare(`SELECT id,owner_id,tags FROM ${table} WHERE deleted_at IS NULL AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
  if(rows.length!==ids.length)return fail(res,404,'Одна из записей не найдена');
  if(rows.some(row=>(kind==='contact'?ownContacts(req):ownCompanies(req))&&row.owner_id!==req.user.id))return fail(res,403,'Нет доступа к одной из записей');
  if(action==='owner'){
    const owner=int(req.body.owner_id);
    if(!idExists('users',owner)||(kind==='contact'?ownContacts(req):ownCompanies(req))&&owner!==req.user.id)return fail(res,400,'Ответственный не найден');
    db.transaction(()=>{const update=db.prepare(`UPDATE ${table} SET owner_id=? WHERE id=?`);for(const row of rows){if(row.owner_id===owner)continue;update.run(owner,row.id);logEntityChanges(kind,row.id,req.user.id,row,{owner_id:owner})}})();
  }else{
    const mode=req.body.mode,input=req.body.tags;
    if(!['add','remove','replace'].includes(mode)||typeof input!=='string'||input.length>1000)return fail(res,400,'Проверьте теги');
    const requested=parseTags(input);
    if(mode!=='replace'&&!requested.length)return fail(res,400,'Укажите теги');
    const requestedKeys=new Set(requested.map(tag=>tag.toLocaleLowerCase('ru')));
    const changes=rows.map(row=>{
      const existing=parseTags(row.tags||'');
      const tags=mode==='replace'?requested:mode==='add'?[...existing,...requested.filter(tag=>!existing.some(old=>old.toLocaleLowerCase('ru')===tag.toLocaleLowerCase('ru')))]:existing.filter(tag=>!requestedKeys.has(tag.toLocaleLowerCase('ru')));
      return {...row,next:tags.join(', ')};
    });
    if(changes.some(row=>row.next.length>1000))return fail(res,400,'Слишком много тегов');
    db.transaction(()=>{const update=db.prepare(`UPDATE ${table} SET tags=? WHERE id=?`);for(const row of changes){if(row.tags===row.next)continue;update.run(row.next,row.id);logEntityChanges(kind,row.id,req.user.id,row,{tags:row.next})}})();
  }
  res.json({ok:true,updated:rows.length});
});
app.post('/api/entities/bulk-field',auth,(req,res)=>{
  const kind=req.body.kind,ids=req.body.ids,field=db.prepare('SELECT * FROM custom_fields WHERE id=?').get(int(req.body.field_id));
  if(!['contact','company'].includes(kind)||!field||field.entity_type!==kind||!Array.isArray(ids)||ids.length<1||ids.length>500||ids.some(id=>!int(id))||new Set(ids.map(Number)).size!==ids.length)return fail(res,400,'Проверьте записи и поле');
  if(!allowed(req,kind,'edit'))return fail(res,403,'Нет прав на это действие');
  if(typeof req.body.value!=='string'||req.body.value.length>1000)return fail(res,400,'Значение слишком длинное');
  const fieldValue=req.body.value.trim();
  const valueError=customValueError(field,fieldValue);if(valueError)return fail(res,400,valueError);
  const rows=db.prepare(`SELECT id,owner_id FROM ${customTables[kind]} WHERE deleted_at IS NULL AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
  if(rows.length!==ids.length)return fail(res,404,'Одна из записей не найдена');
  if(rows.some(row=>(kind==='contact'?ownContacts(req):ownCompanies(req))&&row.owner_id!==req.user.id))return fail(res,403,'Нет доступа к одной из записей');
  db.transaction(()=>{const update=db.prepare('INSERT INTO custom_field_values (field_id,entity_id,value) VALUES (?,?,?) ON CONFLICT(field_id,entity_id) DO UPDATE SET value=excluded.value');const previous=db.prepare('SELECT value FROM custom_field_values WHERE field_id=? AND entity_id=?');for(const row of rows){const before=previous.get(field.id,row.id)?.value||'';update.run(field.id,row.id,fieldValue);if(before!==fieldValue)entityEvent(kind,row.id,req.user.id,`Поле «${field.name}»: ${entityFieldValue('custom',before)} → ${entityFieldValue('custom',fieldValue)}`)}})();
  res.json({ok:true,updated:rows.length});
});
app.post('/api/entities/bulk-task',auth,(req,res)=>{
  const {kind,ids}=req.body,owner=int(req.body.owner_id)||req.user.id;
  if(!['contact','company'].includes(kind)||!Array.isArray(ids)||ids.length<1||ids.length>500||ids.some(id=>!int(id))||new Set(ids.map(Number)).size!==ids.length||!required(req.body.title,500)||!idExists('users',owner))return fail(res,400,'Проверьте задачи и выбранные записи');
  if(!allowed(req,'task','create'))return fail(res,403,'Нет прав на это действие');
  if(ownTasks(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе');
  const rows=db.prepare(`SELECT id,owner_id FROM ${customTables[kind]} WHERE deleted_at IS NULL AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
  if(rows.length!==ids.length)return fail(res,404,'Одна из записей не найдена');
  if(rows.some(row=>(kind==='contact'?ownContacts(req):ownCompanies(req))&&row.owner_id!==req.user.id))return fail(res,403,'Нет доступа к одной из записей');
  db.transaction(()=>{const insert=db.prepare('INSERT INTO tasks (title,task_type,due_at,contact_id,company_id,owner_id) VALUES (?,?,?,?,?,?)');for(const row of rows)insert.run(req.body.title.trim(),value(req.body.task_type,50)||'Связаться',value(req.body.due_at,40)||null,kind==='contact'?row.id:null,kind==='company'?row.id:null,owner)})();
  res.status(201).json({ok:true,created:rows.length});
});
app.post('/api/entities/bulk-delete',auth,(req,res)=>{
  const {kind,ids}=req.body;
  if(!['contact','company'].includes(kind)||!Array.isArray(ids)||ids.length<1||ids.length>500||ids.some(id=>!int(id))||new Set(ids.map(Number)).size!==ids.length)return fail(res,400,'Выберите от 1 до 500 записей без повторов');
  if(!allowed(req,kind,'delete'))return fail(res,403,'Нет прав на это действие');
  const table=customTables[kind],rows=db.prepare(`SELECT id,owner_id FROM ${table} WHERE deleted_at IS NULL AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
  if(rows.length!==ids.length)return fail(res,404,'Одна из записей не найдена');
  if(rows.some(row=>(kind==='contact'?ownContacts(req):ownCompanies(req))&&row.owner_id!==req.user.id))return fail(res,403,'Нет доступа к одной из записей');
  db.transaction(()=>{const update=db.prepare(`UPDATE ${table} SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL`);for(const row of rows){update.run(row.id);entityEvent(kind,row.id,req.user.id,'Запись перемещена в корзину')}})();
  res.json({ok:true,deleted:rows.length});
});
app.get('/api/files',auth,(req,res)=>{
  const page=Math.max(1,int(req.query.page)||1),size=[25,50,100].includes(Number(req.query.page_size))?Number(req.query.page_size):50,q=value(req.query.q,100).toLowerCase();
  const kind=value(req.query.kind,20)||'all';if(!['all','deal','contact','company'].includes(kind))return fail(res,400,'Неизвестный тип файла');
  const from=`FROM attachments a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN deals d ON a.entity_type='deal' AND d.id=a.entity_id LEFT JOIN contacts c ON a.entity_type='contact' AND c.id=a.entity_id LEFT JOIN companies co ON a.entity_type='company' AND co.id=a.entity_id WHERE ((a.entity_type='deal' AND d.deleted_at IS NULL AND d.id IS NOT NULL AND (?=0 OR d.owner_id=?)) OR (a.entity_type='contact' AND c.deleted_at IS NULL AND c.id IS NOT NULL AND (?=0 OR c.owner_id=?)) OR (a.entity_type='company' AND co.deleted_at IS NULL AND co.id IS NOT NULL AND (?=0 OR co.owner_id=?))) AND (?='all' OR a.entity_type=?) AND (lower(a.filename) LIKE ? OR lower(COALESCE(d.name,c.name,co.name,'')) LIKE ?)`;
  const params=[ownDeals(req)?1:0,req.user.id,ownContacts(req)?1:0,req.user.id,ownCompanies(req)?1:0,req.user.id,kind,kind,`%${q}%`,`%${q}%`],total=db.prepare(`SELECT COUNT(*) n ${from}`).get(...params).n;
  const items=db.prepare(`SELECT a.id,a.filename,a.mime_type,a.byte_size,a.created_at,a.entity_type,a.entity_id,u.name author,COALESCE(d.name,c.name,co.name) entity_name ${from} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params,size,(page-1)*size);
  res.json({items,total,page,page_size:size,pages:Math.max(1,Math.ceil(total/size))});
});
app.get('/api/file-targets',auth,(req,res)=>{
  const kind=value(req.query.kind,20),q=value(req.query.q,100).toLowerCase();if(!['deal','contact','company'].includes(kind))return fail(res,400,'Неизвестный тип записи');
  const table={deal:'deals',contact:'contacts',company:'companies'}[kind];
  const rows=kind==='deal'?db.prepare('SELECT id,name FROM deals WHERE deleted_at IS NULL AND (?=0 OR owner_id=?) AND lower(name) LIKE ? ORDER BY id DESC LIMIT 30').all(ownDeals(req)?1:0,req.user.id,`%${q}%`):db.prepare(`SELECT id,name FROM ${table} WHERE deleted_at IS NULL AND (?=0 OR owner_id=?) AND lower(name) LIKE ? ORDER BY id DESC LIMIT 30`).all((kind==='contact'?ownContacts(req):ownCompanies(req))?1:0,req.user.id,`%${q}%`);
  res.json(rows);
});
app.post('/api/attachments/:entity_type/:entity_id',auth,express.raw({type:'application/octet-stream',limit:'15mb'}),(req,res)=>{const type=req.params.entity_type,id=int(req.params.entity_id);if(!customTables[type]||!idExists(customTables[type],id))return fail(res,404,'Запись не найдена');if(!allowed(req,type,'edit'))return fail(res,403,'Нет прав на это действие');if(type==='deal'&&!dealAllowed(req,id))return fail(res,403,'Нет доступа к сделке');if(type!=='deal'&&!entityAllowed(req,type,id))return fail(res,403,'Нет доступа к записи');if(!Buffer.isBuffer(req.body)||!req.body.length)return fail(res,400,'Выберите непустой файл');let filename;try{filename=decodeURIComponent(String(req.get('x-file-name')||''))}catch{return fail(res,400,'Неверное имя файла')}filename=filename.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g,'').trim();if(!filename||filename.length>255)return fail(res,400,'Неверное имя файла');const mime=value(req.get('x-file-type'),120)||'application/octet-stream';const stored=randomBytes(24).toString('hex');writeFileSync(resolve(uploadDir,stored),req.body,{flag:'wx',mode:0o600});try{const row=db.prepare('INSERT INTO attachments (entity_type,entity_id,user_id,filename,mime_type,byte_size,stored_name) VALUES (?,?,?,?,?,?,?)').run(type,id,req.user.id,filename,mime,req.body.length,stored);if(type==='deal')event(id,req.user.id,`Прикреплён файл «${filename}»`);else entityEvent(type,id,req.user.id,`Прикреплён файл «${filename}»`);res.status(201).json({id:row.lastInsertRowid,filename,byte_size:req.body.length})}catch(e){unlinkSync(resolve(uploadDir,stored));throw e}});
app.get('/api/attachments/:id/download',auth,(req,res)=>{const file=db.prepare('SELECT * FROM attachments WHERE id=?').get(int(req.params.id));if(!file)return fail(res,404,'Файл не найден');if(!allowed(req,file.entity_type,'export'))return fail(res,403,'Нет прав на это действие');if(file.entity_type==='deal'&&!dealAllowed(req,file.entity_id))return fail(res,403,'Нет доступа к сделке');if(file.entity_type!=='deal'&&!entityAllowed(req,file.entity_type,file.entity_id))return fail(res,404,'Файл не найден');res.download(resolve(uploadDir,file.stored_name),file.filename)});
app.get('/api/pipelines',auth,(_req,res) => res.json(db.prepare('SELECT * FROM pipelines ORDER BY sort_order,id').all()));
app.post('/api/pipelines',auth,admin,(req,res) => { if (!required(req.body.name,120)) return fail(res,400,'Укажите название'); const r=db.prepare('INSERT INTO pipelines (name,sort_order) VALUES (?,?)').run(req.body.name.trim(),db.prepare('SELECT COUNT(*) n FROM pipelines').get().n); const stage=db.prepare('INSERT INTO stages (pipeline_id,name,color,sort_order,kind) VALUES (?,?,?,?,?)'); [['Новый лид','#f5e768','active'],['В работе','#bcd3f6','active'],['Успешно реализовано','#a9ddb1','won'],['Закрыто и не реализовано','#e8b7b7','lost']].forEach(([name,color,kind],i)=>stage.run(r.lastInsertRowid,name,color,i,kind)); res.status(201).json({id:r.lastInsertRowid,name:req.body.name.trim()}); });
app.patch('/api/pipelines/:id',auth,admin,(req,res)=>{const id=int(req.params.id);if(!idExists('pipelines',id))return fail(res,404,'Воронка не найдена');if(!required(req.body.name,120))return fail(res,400,'Укажите название');const name=req.body.name.trim();db.prepare('UPDATE pipelines SET name=? WHERE id=?').run(name,id);res.json({id,name})});
app.get('/api/stages',auth,(req,res) => { const pid=int(req.query.pipeline_id); res.json(db.prepare('SELECT * FROM stages WHERE pipeline_id=? ORDER BY sort_order,id').all(pid)); });
app.post('/api/stages',auth,admin,(req,res) => { const pid=int(req.body.pipeline_id); if (!idExists('pipelines',pid)||!required(req.body.name,120)) return fail(res,400,'Проверьте этап'); const order=db.prepare("SELECT COUNT(*) n FROM stages WHERE pipeline_id=? AND kind='active'").get(pid).n;const r=db.transaction(()=>{db.prepare('UPDATE stages SET sort_order=sort_order+1 WHERE pipeline_id=? AND sort_order>=?').run(pid,order);return db.prepare('INSERT INTO stages (pipeline_id,name,color,sort_order) VALUES (?,?,?,?)').run(pid,req.body.name.trim(),value(req.body.color,20)||'#cbd9ee',order)})(); res.status(201).json({id:r.lastInsertRowid}); });
app.patch('/api/stages/:id',auth,admin,(req,res) => { const id=int(req.params.id); if (!idExists('stages',id)||!required(req.body.name,120)) return fail(res,400,'Проверьте этап'); db.prepare('UPDATE stages SET name=?,color=? WHERE id=?').run(req.body.name.trim(),value(req.body.color,20)||'#cbd9ee',id); res.json({ok:true}); });
app.put('/api/pipelines/:id/stage-order',auth,admin,(req,res)=>{const pid=int(req.params.id);if(!idExists('pipelines',pid))return fail(res,404,'Воронка не найдена');const actual=db.prepare("SELECT id FROM stages WHERE pipeline_id=? AND kind='active' ORDER BY sort_order,id").all(pid).map(x=>x.id),ids=req.body.ids;if(!Array.isArray(ids)||ids.length!==actual.length||new Set(ids).size!==actual.length||ids.some(id=>!actual.includes(id)))return fail(res,400,'Укажите все рабочие этапы без повторов');db.transaction(()=>{const stmt=db.prepare('UPDATE stages SET sort_order=? WHERE id=?');ids.forEach((id,index)=>stmt.run(index,id))})();res.json({ok:true,ids})});
app.get('/api/pipelines/:id/automations',auth,(req,res)=>{const pid=int(req.params.id);if(!idExists('pipelines',pid))return fail(res,404,'Воронка не найдена');res.json(db.prepare('SELECT a.stage_id,a.task_title,a.due_days FROM stage_automations a JOIN stages s ON s.id=a.stage_id WHERE s.pipeline_id=?').all(pid))});
app.put('/api/stages/:id/automation',auth,admin,(req,res)=>{const id=int(req.params.id);if(!idExists('stages',id))return fail(res,404,'Этап не найден');const title=value(req.body.task_title,255),days=Number(req.body.due_days);if(!title||!Number.isSafeInteger(days)||days<0||days>365)return fail(res,400,'Проверьте правило задачи');db.prepare('INSERT INTO stage_automations (stage_id,task_title,due_days) VALUES (?,?,?) ON CONFLICT(stage_id) DO UPDATE SET task_title=excluded.task_title,due_days=excluded.due_days').run(id,title,days);res.json({stage_id:id,task_title:title,due_days:days})});
app.delete('/api/stages/:id/automation',auth,admin,(req,res)=>{const id=int(req.params.id);if(!idExists('stages',id))return fail(res,404,'Этап не найден');db.prepare('DELETE FROM stage_automations WHERE stage_id=?').run(id);res.json({ok:true})});
app.get('/api/inbox',auth,(req,res)=>{const pid=int(req.query.pipeline_id),state=value(req.query.state,20)||'pending';if(!idExists('pipelines',pid))return fail(res,400,'Укажите воронку');if(!['pending','accepted','rejected','all'].includes(state))return fail(res,400,'Неверный статус');res.json(db.prepare(`SELECT l.*,u.name resolved_by_name FROM inbox_leads l LEFT JOIN users u ON u.id=l.resolved_by WHERE l.pipeline_id=? ${state==='all'?'':'AND l.status=?'} AND (?=0 OR l.status='pending' OR l.resolved_by=?) ORDER BY l.id DESC LIMIT 500`).all(...(state==='all'?[pid,ownDeals(req)?1:0,req.user.id]:[pid,state,ownDeals(req)?1:0,req.user.id])))});
app.post('/api/inbox',auth,requirePermission('deal','create'),(req,res)=>{const pid=int(req.body.pipeline_id),title=value(req.body.title,255),contactName=value(req.body.contact_name,255),companyName=value(req.body.company_name,255),email=value(req.body.email,254),phone=value(req.body.phone,80);if(!idExists('pipelines',pid)||!title||(!contactName&&!companyName&&!email&&!phone)||email&&!email.includes('@'))return fail(res,400,'Проверьте данные заявки');const result=db.prepare('INSERT INTO inbox_leads (pipeline_id,title,contact_name,company_name,phone,email,website,source,message,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(pid,title,contactName,companyName,phone,email.toLowerCase(),value(req.body.website,255),value(req.body.source,255)||'Вручную',value(req.body.message,10000),req.user.id);res.status(201).json({id:result.lastInsertRowid})});
app.post('/api/inbox/:id/accept',auth,requirePermission('deal','create'),(req,res)=>{const id=int(req.params.id),lead=db.prepare('SELECT * FROM inbox_leads WHERE id=?').get(id);if(!lead)return fail(res,404,'Заявка не найдена');if(lead.status!=='pending')return fail(res,409,'Заявка уже обработана');const stage=int(req.body.stage_id),stageRow=db.prepare('SELECT pipeline_id,kind FROM stages WHERE id=?').get(stage),owner=int(req.body.owner_id)||req.user.id;if(!stageRow||stageRow.pipeline_id!==lead.pipeline_id||stageRow.kind!=='active'||!idExists('users',owner))return fail(res,400,'Выберите рабочий этап этой воронки');if(ownDeals(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе');if(lead.company_name&&!allowed(req,'company','create')&&!db.prepare('SELECT id FROM companies WHERE deleted_at IS NULL AND lower(name)=lower(?) LIMIT 1').get(lead.company_name))return fail(res,403,'Нет прав на создание компании');if((lead.contact_name||lead.email||lead.phone)&&!allowed(req,'contact','create')){const existing=lead.email?db.prepare("SELECT id FROM contacts WHERE deleted_at IS NULL AND lower(email)=lower(?) AND email<>'' ORDER BY id LIMIT 1").get(lead.email):lead.phone?db.prepare("SELECT id FROM contacts WHERE deleted_at IS NULL AND phone=? AND phone<>'' ORDER BY id LIMIT 1").get(lead.phone):null;if(!existing)return fail(res,403,'Нет прав на создание контакта')}const dealId=db.transaction(()=>{let companyId=null,contactId=null;if(lead.company_name){const existing=db.prepare('SELECT id FROM companies WHERE deleted_at IS NULL AND lower(name)=lower(?) ORDER BY id LIMIT 1').get(lead.company_name);companyId=existing?.id||(()=>{const created=db.prepare('INSERT INTO companies (name,owner_id,website) VALUES (?,?,?)').run(lead.company_name,owner,lead.website).lastInsertRowid;entityEvent('company',created,req.user.id,'Компания создана из входящей заявки');return created})()}if(lead.contact_name||lead.email||lead.phone){const existing=lead.email?db.prepare("SELECT id FROM contacts WHERE deleted_at IS NULL AND lower(email)=lower(?) AND email<>'' ORDER BY id LIMIT 1").get(lead.email):lead.phone?db.prepare("SELECT id FROM contacts WHERE deleted_at IS NULL AND phone=? AND phone<>'' ORDER BY id LIMIT 1").get(lead.phone):null;contactId=existing?.id||(()=>{const created=db.prepare('INSERT INTO contacts (name,company_id,owner_id,phone,email) VALUES (?,?,?,?,?)').run(lead.contact_name||lead.email||lead.phone,companyId,owner,lead.phone,lead.email).lastInsertRowid;entityEvent('contact',created,req.user.id,'Контакт создан из входящей заявки');return created})()}const deal=db.prepare('INSERT INTO deals (name,stage_id,company_id,contact_id,owner_id,source,description) VALUES (?,?,?,?,?,?,?)').run(lead.title,stage,companyId,contactId,owner,lead.source,lead.message);db.prepare("UPDATE inbox_leads SET status='accepted',deal_id=?,resolved_by=?,resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(deal.lastInsertRowid,req.user.id,id);if(contactId)db.prepare('INSERT OR IGNORE INTO deal_contacts (deal_id,contact_id) VALUES (?,?)').run(deal.lastInsertRowid,contactId);event(deal.lastInsertRowid,req.user.id,`Заявка #${id} принята`);runStageAutomation(deal.lastInsertRowid,stage,owner,req.user.id);return deal.lastInsertRowid})();res.json({ok:true,deal_id:dealId})});
app.post('/api/inbox/:id/reject',auth,(req,res)=>{const id=int(req.params.id),lead=db.prepare('SELECT status FROM inbox_leads WHERE id=?').get(id);if(!lead)return fail(res,404,'Заявка не найдена');if(lead.status!=='pending')return fail(res,409,'Заявка уже обработана');db.prepare("UPDATE inbox_leads SET status='rejected',resolved_by=?,resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id,id);res.json({ok:true})});
app.post('/api/inbox/:id/restore',auth,(req,res)=>{const id=int(req.params.id),lead=db.prepare('SELECT status,resolved_by FROM inbox_leads WHERE id=?').get(id);if(!lead)return fail(res,404,'Заявка не найдена');if(ownDeals(req)&&lead.resolved_by!==req.user.id)return fail(res,403,'Нет доступа к заявке');if(lead.status!=='rejected')return fail(res,409,'Можно восстановить только отклонённую заявку');db.prepare("UPDATE inbox_leads SET status='pending',resolved_by=NULL,resolved_at=NULL WHERE id=?").run(id);res.json({ok:true})});
app.get('/api/pipelines/:id/forms',auth,(req,res)=>{const pid=int(req.params.id);if(!idExists('pipelines',pid))return fail(res,404,'Воронка не найдена');res.json(db.prepare('SELECT id,pipeline_id,title,token,active,created_at FROM lead_forms WHERE pipeline_id=? ORDER BY id DESC').all(pid))});
app.post('/api/pipelines/:id/forms',auth,admin,(req,res)=>{const pid=int(req.params.id),title=value(req.body.title,120);if(!idExists('pipelines',pid))return fail(res,404,'Воронка не найдена');if(!title)return fail(res,400,'Укажите название формы');const token=randomBytes(24).toString('hex');const row=db.prepare('INSERT INTO lead_forms (pipeline_id,title,token) VALUES (?,?,?)').run(pid,title,token);res.status(201).json({id:row.lastInsertRowid,pipeline_id:pid,title,token,active:1})});
app.patch('/api/forms/:id',auth,admin,(req,res)=>{const id=int(req.params.id),form=db.prepare('SELECT * FROM lead_forms WHERE id=?').get(id);if(!form)return fail(res,404,'Форма не найдена');const title=value(req.body.title,120),active=req.body.active;if(!title||typeof active!=='boolean')return fail(res,400,'Проверьте настройки формы');db.prepare('UPDATE lead_forms SET title=?,active=? WHERE id=?').run(title,active?1:0,id);res.json({id,title,active:active?1:0})});
const publicFormRates=new Map();
app.get('/api/public/forms/:token',(req,res)=>{const form=db.prepare('SELECT title FROM lead_forms WHERE token=? AND active=1').get(req.params.token);if(!form)return fail(res,404,'Форма не найдена');res.json(form)});
app.post('/api/public/forms/:token',(req,res)=>{const form=db.prepare('SELECT * FROM lead_forms WHERE token=? AND active=1').get(req.params.token);if(!form)return fail(res,404,'Форма не найдена');const key=req.ip+':'+form.id,now=Date.now(),recent=(publicFormRates.get(key)||[]).filter(t=>now-t<60000);if(recent.length>=20)return fail(res,429,'Слишком много отправок. Повторите позже');recent.push(now);publicFormRates.set(key,recent);if(req.body.website_hidden)return res.status(201).json({ok:true});const contactName=value(req.body.contact_name,255),companyName=value(req.body.company_name,255),phone=value(req.body.phone,80),email=value(req.body.email,254),title=value(req.body.title,255)||`Заявка: ${form.title}`;if((!contactName&&!companyName&&!phone&&!email)||(email&&!email.includes('@'))||!title)return fail(res,400,'Укажите контактные данные');const result=db.prepare('INSERT INTO inbox_leads (pipeline_id,title,contact_name,company_name,phone,email,website,source,message) VALUES (?,?,?,?,?,?,?,?,?)').run(form.pipeline_id,title,contactName,companyName,phone,email.toLowerCase(),value(req.body.website,255),`Форма: ${form.title}`.slice(0,255),value(req.body.message,10000));res.status(201).json({ok:true,id:result.lastInsertRowid})});

app.get('/api/entity-list',auth,(req,res)=>{
  const kind=value(req.query.kind,20),page=Number(req.query.page||1),size=Number(req.query.page_size||50),q=value(req.query.q,120),owner=value(req.query.owner_id,30),tag=value(req.query.tag,120),preset=value(req.query.preset,20),createdFrom=value(req.query.created_from,10),createdTo=value(req.query.created_to,10);
  if(!['contact','company','all'].includes(kind)||!Number.isSafeInteger(page)||page<1||page>100000||![25,50,100].includes(size)||owner&&owner!=='unassigned'&&!int(owner)||!['','no_tasks','overdue','no_deals'].includes(preset)||createdFrom&&!/^\d{4}-\d{2}-\d{2}$/.test(createdFrom)||createdTo&&!/^\d{4}-\d{2}-\d{2}$/.test(createdTo)||createdFrom&&createdTo&&createdFrom>createdTo)return fail(res,400,'Проверьте параметры списка');
  const pattern=`%${q}%`;
  const ownerSql=alias=>owner==='unassigned'?` AND ${alias}.owner_id IS NULL`:owner?` AND ${alias}.owner_id=?`:'';
  const tagSql=alias=>tag?` AND has_entity_tag(${alias}.tags,?)`:'';
  const dateSql=alias=>`${createdFrom?` AND date(${alias}.created_at)>=?`:''}${createdTo?` AND date(${alias}.created_at)<=?`:''}`;
  const visibleDeal=ownDeals(req)?` AND d.owner_id=${req.user.id}`:'';
  const visibleTask=`${ownTasks(req)?` AND t.owner_id=${req.user.id}`:''}${ownDeals(req)?` AND (t.deal_id IS NULL OR EXISTS(SELECT 1 FROM deals d WHERE d.id=t.deal_id AND d.deleted_at IS NULL AND d.owner_id=${req.user.id}))`:''}`;
  const contactDeal=`EXISTS(SELECT 1 FROM deals d WHERE d.deleted_at IS NULL${visibleDeal} AND (d.contact_id=c.id OR EXISTS(SELECT 1 FROM deal_contacts dc WHERE dc.deal_id=d.id AND dc.contact_id=c.id)))`;
  const companyDeal=`EXISTS(SELECT 1 FROM deals d WHERE d.deleted_at IS NULL${visibleDeal} AND d.company_id=co.id)`;
  const dueTask=preset==='overdue'?" AND t.due_at IS NOT NULL AND julianday(t.due_at)<julianday('now')":'';
  const openTask=`t.deleted_at IS NULL AND t.completed_at IS NULL${visibleTask}${dueTask}`;
  const contactTask=`(EXISTS(SELECT 1 FROM tasks t WHERE t.contact_id=c.id AND ${openTask}) OR EXISTS(SELECT 1 FROM deals d JOIN tasks t ON t.deal_id=d.id WHERE d.deleted_at IS NULL AND (d.contact_id=c.id OR EXISTS(SELECT 1 FROM deal_contacts dc WHERE dc.deal_id=d.id AND dc.contact_id=c.id)) AND ${openTask}))`;
  const companyTask=`(EXISTS(SELECT 1 FROM tasks t WHERE t.company_id=co.id AND ${openTask}) OR EXISTS(SELECT 1 FROM deals d JOIN tasks t ON t.deal_id=d.id WHERE d.deleted_at IS NULL AND d.company_id=co.id AND ${openTask}))`;
  const presetSql=(deal,task)=>preset==='no_deals'?` AND NOT ${deal}`:preset==='no_tasks'?` AND NOT ${task}`:preset==='overdue'?` AND ${task}`:'';
  const contacts=`SELECT c.id,c.name,c.company_id,COALESCE(co.name,'') company_name,c.owner_id,COALESCE(u.name,'') owner_name,c.phone,c.email,'' website,c.position,c.tags,c.created_at,(SELECT json_group_object(v.field_id,v.value) FROM custom_field_values v JOIN custom_fields f ON f.id=v.field_id AND f.entity_type='contact' WHERE v.entity_id=c.id) custom_values,'contact' _kind FROM contacts c LEFT JOIN companies co ON co.id=c.company_id AND co.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR co.owner_id=${req.user.id}) LEFT JOIN users u ON u.id=c.owner_id WHERE c.deleted_at IS NULL${ownContacts(req)?` AND c.owner_id=${req.user.id}`:''} AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR co.name LIKE ? OR c.tags LIKE ?)${ownerSql('c')}${tagSql('c')}${dateSql('c')}${presetSql(contactDeal,contactTask)}`;
  const companies=`SELECT co.id,co.name,NULL company_id,'' company_name,co.owner_id,COALESCE(u.name,'') owner_name,co.phone,co.email,co.website,'' position,co.tags,co.created_at,(SELECT json_group_object(v.field_id,v.value) FROM custom_field_values v JOIN custom_fields f ON f.id=v.field_id AND f.entity_type='company' WHERE v.entity_id=co.id) custom_values,'company' _kind FROM companies co LEFT JOIN users u ON u.id=co.owner_id WHERE co.deleted_at IS NULL${ownCompanies(req)?` AND co.owner_id=${req.user.id}`:''} AND (co.name LIKE ? OR co.email LIKE ? OR co.phone LIKE ? OR co.website LIKE ? OR co.tags LIKE ?)${ownerSql('co')}${tagSql('co')}${dateSql('co')}${presetSql(companyDeal,companyTask)}`;
  const sql=kind==='contact'?contacts:kind==='company'?companies:`${contacts} UNION ALL ${companies}`;
  const branchParams=()=>[...Array(5).fill(pattern),...(owner&&owner!=='unassigned'?[Number(owner)]:[]),...(tag?[tag]:[]),...(createdFrom?[createdFrom]:[]),...(createdTo?[createdTo]:[])];
  const params=kind==='all'?[...branchParams(),...branchParams()]:branchParams();
  const total=db.prepare(`SELECT COUNT(*) n FROM (${sql})`).get(...params).n;
  const items=db.prepare(`SELECT * FROM (${sql}) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params,size,(page-1)*size);
  res.json({items,total,page,page_size:size,pages:Math.max(1,Math.ceil(total/size))});
});
app.get('/api/entity-tags',auth,(req,res)=>{
  const kind=value(req.query.kind,20);
  if(!['contact','company','all'].includes(kind))return fail(res,400,'Проверьте тип списка');
  const tables=kind==='all'?['contacts','companies']:[kind==='contact'?'contacts':'companies'];
  const counts=new Map();
  for(const table of tables)for(const row of db.prepare(`SELECT tags FROM ${table} WHERE deleted_at IS NULL AND tags<>'' AND (?=0 OR owner_id=?)`).all((table==='contacts'?ownContacts(req):ownCompanies(req))?1:0,req.user.id))for(const tag of String(row.tags).split(',').map(item=>item.trim()).filter(Boolean)){const key=tag.toLocaleLowerCase('ru-RU');const previous=counts.get(key);counts.set(key,{tag:previous?.tag||tag,count:(previous?.count||0)+1})}
  res.json([...counts.values()].sort((a,b)=>b.count-a.count||a.tag.localeCompare(b.tag,'ru')).slice(0,100));
});
app.get('/api/companies',auth,(req,res) => { const q=value(req.query.q,120); res.json(db.prepare('SELECT co.*,u.name owner_name FROM companies co LEFT JOIN users u ON u.id=co.owner_id WHERE co.deleted_at IS NULL AND (?=0 OR co.owner_id=?) AND (co.name LIKE ? OR co.tags LIKE ?) ORDER BY co.id DESC LIMIT 500').all(ownCompanies(req)?1:0,req.user.id,`%${q}%`,`%${q}%`)); });
app.get('/api/companies/:id',auth,(req,res) => { const id=int(req.params.id);if(!entityAllowed(req,'company',id))return fail(res,404,'Компания не найдена');const company=db.prepare('SELECT co.*,u.name owner_name FROM companies co LEFT JOIN users u ON u.id=co.owner_id WHERE co.id=? AND co.deleted_at IS NULL').get(id); if(!company)return fail(res,404,'Компания не найдена'); res.json({...company,contacts:db.prepare('SELECT * FROM contacts WHERE company_id=? AND deleted_at IS NULL AND (?=0 OR owner_id=?) ORDER BY id DESC').all(id,ownContacts(req)?1:0,req.user.id),deals:db.prepare(`${dealSelect(req)} WHERE d.company_id=? AND d.deleted_at IS NULL AND (?=0 OR d.owner_id=?) ORDER BY d.id DESC`).all(id,ownDeals(req)?1:0,req.user.id),tasks:db.prepare('SELECT t.*,d.name deal_name,u.name owner_name FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id LEFT JOIN users u ON u.id=t.owner_id WHERE t.deleted_at IS NULL AND (t.company_id=? OR d.company_id=?) AND (t.deal_id IS NULL OR d.deleted_at IS NULL) AND (?=0 OR t.owner_id=?) AND (?=0 OR t.deal_id IS NULL OR d.owner_id=?) ORDER BY t.completed_at IS NOT NULL,t.due_at,t.id DESC').all(id,id,ownTasks(req)?1:0,req.user.id,ownDeals(req)?1:0,req.user.id),activity:db.prepare("SELECT a.*,u.name author FROM entity_activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity_type='company' AND a.entity_id=? ORDER BY a.id DESC LIMIT 200").all(id),timeline_notes:db.prepare("SELECT n.*,u.name author FROM entity_notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.entity_type='company' AND n.entity_id=? ORDER BY n.id DESC").all(id),custom_fields:customFieldsFor('company',id),attachments:attachmentsFor('company',id)}); });
app.post('/api/companies',auth,requirePermission('company','create'),(req,res)=>{
  if(!required(req.body.name,255))return fail(res,400,'Укажите компанию');
  const owner=int(req.body.owner_id??req.user.id);
  if(!idExists('users',owner))return fail(res,400,'Ответственный не найден');
  if(ownCompanies(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе');
  const saved={name:req.body.name.trim(),owner_id:owner,website:value(req.body.website,255),address:value(req.body.address,500),phone:value(req.body.phone,80),email:value(req.body.email,254),notes:value(req.body.notes,5000),tags:value(req.body.tags,1000)};
  const id=db.transaction(()=>{const row=db.prepare('INSERT INTO companies (name,owner_id,website,address,phone,email,notes,tags) VALUES (?,?,?,?,?,?,?,?)').run(saved.name,saved.owner_id,saved.website,saved.address,saved.phone,saved.email,saved.notes,saved.tags);entityEvent('company',row.lastInsertRowid,req.user.id,'Компания создана');return row.lastInsertRowid})();
  res.status(201).json({id});
});
app.patch('/api/companies/:id',auth,requirePermission('company','edit'),(req,res)=>{
  const id=int(req.params.id),old=entityAllowed(req,'company',id)?db.prepare('SELECT * FROM companies WHERE id=? AND deleted_at IS NULL').get(id):null;
  if(!old)return fail(res,404,'Компания не найдена');
  const x={...old,...req.body},owner=x.owner_id===null?null:int(x.owner_id);
  if(!required(x.name,255)||x.owner_id!==null&&!idExists('users',owner))return fail(res,400,'Проверьте компанию');
  if(ownCompanies(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе');
  const saved={name:x.name.trim(),owner_id:owner,website:value(x.website,255),address:value(x.address,500),phone:value(x.phone,80),email:value(x.email,254),notes:value(x.notes,5000),tags:value(x.tags,1000)};
  db.transaction(()=>{db.prepare('UPDATE companies SET name=?,owner_id=?,website=?,address=?,phone=?,email=?,notes=?,tags=? WHERE id=?').run(saved.name,saved.owner_id,saved.website,saved.address,saved.phone,saved.email,saved.notes,saved.tags,id);logEntityChanges('company',id,req.user.id,old,saved)})();
  res.json({ok:true});
});
app.get('/api/contacts',auth,(req,res) => { const q=value(req.query.q,120); res.json(db.prepare(`SELECT c.*,co.name company_name,u.name owner_name FROM contacts c LEFT JOIN companies co ON co.id=c.company_id AND co.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR co.owner_id=${req.user.id}) LEFT JOIN users u ON u.id=c.owner_id WHERE c.deleted_at IS NULL AND (?=0 OR c.owner_id=?) AND (c.name LIKE ? OR c.email LIKE ? OR c.tags LIKE ?) ORDER BY c.id DESC LIMIT 500`).all(ownContacts(req)?1:0,req.user.id,`%${q}%`,`%${q}%`,`%${q}%`)); });
app.get('/api/contacts/:id',auth,(req,res) => { const id=int(req.params.id);if(!entityAllowed(req,'contact',id))return fail(res,404,'Контакт не найден');const contact=db.prepare(`SELECT c.*,co.name company_name,u.name owner_name FROM contacts c LEFT JOIN companies co ON co.id=c.company_id AND co.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR co.owner_id=${req.user.id}) LEFT JOIN users u ON u.id=c.owner_id WHERE c.id=? AND c.deleted_at IS NULL`).get(id); if(!contact)return fail(res,404,'Контакт не найден'); res.json({...contact,deals:db.prepare(`${dealSelect(req)} WHERE (d.contact_id=? OR EXISTS(SELECT 1 FROM deal_contacts dc WHERE dc.deal_id=d.id AND dc.contact_id=?)) AND d.deleted_at IS NULL AND (?=0 OR d.owner_id=?) ORDER BY d.id DESC`).all(id,id,ownDeals(req)?1:0,req.user.id),tasks:db.prepare('SELECT t.*,d.name deal_name,u.name owner_name FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id LEFT JOIN users u ON u.id=t.owner_id WHERE t.deleted_at IS NULL AND (t.contact_id=? OR d.contact_id=? OR EXISTS(SELECT 1 FROM deal_contacts dc WHERE dc.deal_id=d.id AND dc.contact_id=?)) AND (t.deal_id IS NULL OR d.deleted_at IS NULL) AND (?=0 OR t.owner_id=?) AND (?=0 OR t.deal_id IS NULL OR d.owner_id=?) ORDER BY t.id DESC').all(id,id,id,ownTasks(req)?1:0,req.user.id,ownDeals(req)?1:0,req.user.id),activity:db.prepare("SELECT a.*,u.name author FROM entity_activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity_type='contact' AND a.entity_id=? ORDER BY a.id DESC LIMIT 200").all(id),timeline_notes:db.prepare("SELECT n.*,u.name author FROM entity_notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.entity_type='contact' AND n.entity_id=? ORDER BY n.id DESC").all(id),custom_fields:customFieldsFor('contact',id),attachments:attachmentsFor('contact',id)}); });
app.post('/api/contacts',auth,requirePermission('contact','create'),(req,res)=>{
  if(!required(req.body.name,255))return fail(res,400,'Укажите контакт');
  const company=int(req.body.company_id),owner=int(req.body.owner_id??req.user.id);
  if(company&&!idExists('companies',company)||!idExists('users',owner))return fail(res,400,'Проверьте контакт');
  if(ownContacts(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе');
  if(company&&!entityAllowed(req,'company',company))return fail(res,403,'Нет доступа к компании');
  const saved={name:req.body.name.trim(),company_id:company,owner_id:owner,phone:value(req.body.phone,80),email:value(req.body.email,254),position:value(req.body.position,255),notes:value(req.body.notes,5000),tags:value(req.body.tags,1000)};
  const id=db.transaction(()=>{const row=db.prepare('INSERT INTO contacts (name,company_id,owner_id,phone,email,position,notes,tags) VALUES (?,?,?,?,?,?,?,?)').run(saved.name,saved.company_id,saved.owner_id,saved.phone,saved.email,saved.position,saved.notes,saved.tags);entityEvent('contact',row.lastInsertRowid,req.user.id,'Контакт создан');return row.lastInsertRowid})();
  res.status(201).json({id});
});
app.patch('/api/contacts/:id',auth,requirePermission('contact','edit'),(req,res)=>{
  const id=int(req.params.id),old=entityAllowed(req,'contact',id)?db.prepare('SELECT * FROM contacts WHERE id=? AND deleted_at IS NULL').get(id):null;
  if(!old)return fail(res,404,'Контакт не найден');
  const x={...old,...req.body},company=int(x.company_id),owner=x.owner_id===null?null:int(x.owner_id);
  if(!required(x.name,255)||company&&company!==old.company_id&&!idExists('companies',company)||x.owner_id!==null&&!idExists('users',owner))return fail(res,400,'Проверьте контакт');
  if(ownContacts(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе');
  if(company&&!entityAllowed(req,'company',company))return fail(res,403,'Нет доступа к компании');
  const saved={name:x.name.trim(),company_id:company,owner_id:owner,phone:value(x.phone,80),email:value(x.email,254),position:value(x.position,255),notes:value(x.notes,5000),tags:value(x.tags,1000)};
  db.transaction(()=>{db.prepare('UPDATE contacts SET name=?,company_id=?,owner_id=?,phone=?,email=?,position=?,notes=?,tags=? WHERE id=?').run(saved.name,saved.company_id,saved.owner_id,saved.phone,saved.email,saved.position,saved.notes,saved.tags,id);logEntityChanges('contact',id,req.user.id,old,saved)})();
  res.json({ok:true});
});
app.post('/api/entity-notes/:entity_type/:id',auth,(req,res) => { const type=req.params.entity_type,id=int(req.params.id);if(!['contact','company'].includes(type))return fail(res,404,'Маршрут не найден');if(!allowed(req,type,'edit'))return fail(res,403,'Нет прав на это действие');if(!entityAllowed(req,type,id))return fail(res,404,'Запись не найдена');if(!required(req.body.body,10000))return fail(res,400,'Введите заметку'); const r=db.prepare('INSERT INTO entity_notes (entity_type,entity_id,user_id,body) VALUES (?,?,?,?)').run(type,id,req.user.id,req.body.body.trim());res.status(201).json({id:r.lastInsertRowid}); });

app.get('/api/trash/entities',auth,(req,res)=>{
  const kind=value(req.query.kind,20);
  if(!['contact','company'].includes(kind))return fail(res,400,'Неизвестный тип записи');
  const table=customTables[kind];
  res.json(db.prepare(`SELECT id,name,deleted_at FROM ${table} WHERE deleted_at IS NOT NULL AND (?=0 OR owner_id=?) ORDER BY deleted_at DESC,id DESC LIMIT 500`).all((kind==='contact'?ownContacts(req):ownCompanies(req))?1:0,req.user.id));
});
for(const table of ['contacts','companies']){
  const entity=table==='contacts'?'contact':'company';
  app.delete(`/api/${table}/:id`,auth,requirePermission(entity,'delete'),(req,res)=>{
    const id=int(req.params.id);if(!entityAllowed(req,entity,id))return fail(res,404,'Запись не найдена');
    const result=db.prepare(`UPDATE ${table} SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL`).run(id);
    if(!result.changes)return fail(res,404,'Запись не найдена');
    entityEvent(entity,id,req.user.id,'Запись перемещена в корзину');
    res.json({ok:true});
  });
  app.post(`/api/${table}/:id/restore`,auth,requirePermission(entity,'create'),(req,res)=>{
    const id=int(req.params.id),own=entity==='contact'?ownContacts(req):ownCompanies(req),result=db.prepare(`UPDATE ${table} SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL AND (?=0 OR owner_id=?)`).run(id,own?1:0,req.user.id);
    if(!result.changes)return fail(res,404,'Запись не найдена в корзине');
    entityEvent(entity,id,req.user.id,'Запись восстановлена из корзины');
    res.json({ok:true});
  });
}

app.get('/api/trash/deals',auth,(req,res)=>res.json(db.prepare('SELECT d.id,d.name,d.amount,d.deleted_at,u.name owner_name,s.name stage_name FROM deals d LEFT JOIN users u ON u.id=d.owner_id JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NOT NULL AND (?=0 OR d.owner_id=?) ORDER BY d.deleted_at DESC,d.id DESC LIMIT 500').all(ownDeals(req)?1:0,req.user.id)));
app.post('/api/deals/bulk',auth,(req,res)=>{
  const ids=req.body.ids,action=req.body.action;
  if(!Array.isArray(ids)||ids.length<1||ids.length>500||ids.some(id=>!int(id))||new Set(ids.map(Number)).size!==ids.length)return fail(res,400,'Выберите от 1 до 500 сделок без повторов');
  if(!['owner','stage','task','delete','field','tags'].includes(action))return fail(res,400,'Неизвестное действие');
  if(!allowed(req,action==='task'?'task':'deal',action==='task'?'create':action==='delete'?'delete':'edit'))return fail(res,403,'Нет прав на это действие');
  const rows=db.prepare(`SELECT id,owner_id,stage_id,tags FROM deals WHERE deleted_at IS NULL AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
  if(rows.length!==ids.length)return fail(res,404,'Одна из сделок не найдена');
  if(ownDeals(req)&&rows.some(row=>row.owner_id!==req.user.id))return fail(res,403,'Нет доступа к одной из сделок');
  const owner=int(req.body.owner_id),stage=int(req.body.stage_id),title=value(req.body.title,500),due=value(req.body.due_at,40)||null,reason=lossReason(req.body.loss_reason??'');
  const field=int(req.body.field_id),fieldRow=action==='field'?db.prepare("SELECT * FROM custom_fields WHERE id=? AND entity_type='deal'").get(field):null;
  const fieldValue=typeof req.body.value==='string'?req.body.value.trim():null;
  const tagMode=req.body.mode,tagInput=typeof req.body.tags==='string'?req.body.tags:null;
  let tagUpdates=[];
  if(action==='owner'&&(!idExists('users',owner)||ownDeals(req)&&owner!==req.user.id))return fail(res,400,'Проверьте ответственного');
  if(action==='stage'&&!idExists('stages',stage))return fail(res,400,'Проверьте этап');
  if(action==='stage'&&reason===null)return fail(res,400,'Проверьте причину отказа');
  if(action==='task'&&(!required(req.body.title,500)||!idExists('users',owner||req.user.id)||ownTasks(req)&&(owner||req.user.id)!==req.user.id))return fail(res,400,'Проверьте задачу');
  if(action==='field'){
    if(!fieldRow||fieldValue===null||fieldValue.length>1000)return fail(res,400,'Проверьте поле');
    const valueError=customValueError(fieldRow,fieldValue);if(valueError)return fail(res,400,valueError);
  }
  if(action==='tags'){
    if(!['add','remove','replace'].includes(tagMode)||tagInput===null||tagInput.length>1000)return fail(res,400,'Проверьте теги');
    const incoming=parseTags(tagInput);
    if(!incoming.length&&tagMode!=='replace')return fail(res,400,'Укажите теги');
    tagUpdates=rows.map(row=>{
      const previous=parseTags(row.tags||'');
      const next=tagMode==='replace'?incoming:tagMode==='add'?parseTags([...previous,...incoming].join(',')):previous.filter(tag=>!incoming.some(item=>item.toLocaleLowerCase('ru')===tag.toLocaleLowerCase('ru')));
      return {id:row.id,tags:next.join(', ')};
    });
    if(tagUpdates.some(row=>row.tags.length>1000))return fail(res,400,'Слишком много тегов');
  }
  if(!['owner','stage','task','delete','field','tags'].includes(action))return fail(res,400,'Неизвестное действие');
  db.transaction(()=>{
    for(const row of rows){
      if(action==='owner'){
        db.prepare('UPDATE deals SET owner_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(owner,row.id);
        event(row.id,req.user.id,'Ответственный изменён');
      }else if(action==='stage'){
        if(row.stage_id===stage)continue;
        const savedReason=stageKind(stage)==='lost'?reason:'';
        db.prepare('UPDATE deals SET stage_id=?,loss_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(stage,savedReason,row.id);
        event(row.id,req.user.id,`Этап изменён: ${db.prepare('SELECT name FROM stages WHERE id=?').get(stage).name}${savedReason?` · ${savedReason}`:''}`);
        runStageAutomation(row.id,stage,row.owner_id,req.user.id);
      }else if(action==='task'){
        db.prepare('INSERT INTO tasks (title,task_type,due_at,deal_id,owner_id) VALUES (?,\'Связаться\',?,?,?)').run(title,due,row.id,owner||req.user.id);
        event(row.id,req.user.id,'Задача создана массовым действием');
      }else if(action==='field'){
        db.prepare('INSERT INTO custom_field_values (field_id,entity_id,value) VALUES (?,?,?) ON CONFLICT(field_id,entity_id) DO UPDATE SET value=excluded.value').run(field,row.id,fieldValue);
        event(row.id,req.user.id,`Поле «${fieldRow.name}» изменено`);
      }else if(action==='tags'){
        db.prepare('UPDATE deals SET tags=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(tagUpdates.find(item=>item.id===row.id).tags,row.id);
        event(row.id,req.user.id,'Теги изменены');
      }else{
        event(row.id,req.user.id,'Сделка перемещена в корзину');
        db.prepare('UPDATE deals SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id);
      }
    }
  })();
  res.json({ok:true,updated:rows.length});
});
app.post('/api/deals/:id/restore',auth,requirePermission('deal','create'),(req,res)=>{const id=int(req.params.id),deal=db.prepare('SELECT id,owner_id,deleted_at FROM deals WHERE id=?').get(id);if(!deal||!deal.deleted_at)return fail(res,404,'Сделка не найдена в корзине');if(ownDeals(req)&&deal.owner_id!==req.user.id)return fail(res,403,'Нет доступа к сделке');db.prepare('UPDATE deals SET deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);event(id,req.user.id,'Сделка восстановлена');res.json({ok:true})});
app.post('/api/deals/quick',auth,requirePermission('deal','create'),(req,res)=>{
  const stage=int(req.body.stage_id),stageRow=db.prepare('SELECT kind FROM stages WHERE id=?').get(stage),money=amount(req.body.amount??0);
  const name=value(req.body.name,255),contactName=value(req.body.contact_name,255),phone=value(req.body.contact_phone,80),email=value(req.body.contact_email,254),companyName=value(req.body.company_name,255),address=value(req.body.company_address,500);
  const existingContact=int(req.body.contact_id),existingCompany=int(req.body.company_id),owner=int(req.body.owner_id)||req.user.id;
  if(!name||!stageRow||stageRow.kind!=='active'||money===null||email&&!email.includes('@')||address&&!companyName||existingContact&&(contactName||phone||email)||existingCompany&&companyName||existingContact&&!idExists('contacts',existingContact)||existingCompany&&!idExists('companies',existingCompany)||!idExists('users',owner))return fail(res,400,'Проверьте данные быстрого добавления');
  if(ownDeals(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе');
  if(!linkedEntityAllowed(req,existingContact,existingCompany))return fail(res,403,'Нет доступа к контакту или компании');
  if((contactName||phone||email)&&!allowed(req,'contact','create'))return fail(res,403,'Нет прав на создание контакта');
  if(companyName&&!allowed(req,'company','create'))return fail(res,403,'Нет прав на создание компании');
  if(owner!==req.user.id&&(((contactName||phone||email)&&ownContacts(req))||(companyName&&ownCompanies(req))))return fail(res,403,'Можно назначать только себе');
  const dealId=db.transaction(()=>{
    let companyId=existingCompany||null,contactId=existingContact||null;
    if(companyName){companyId=db.prepare('INSERT INTO companies (name,owner_id,address) VALUES (?,?,?)').run(companyName,owner,address).lastInsertRowid;entityEvent('company',companyId,owner,'Компания создана при быстром добавлении сделки')}
    if(contactName||phone||email){contactId=db.prepare('INSERT INTO contacts (name,company_id,owner_id,phone,email) VALUES (?,?,?,?,?)').run(contactName||email||phone,companyId,owner,phone,email).lastInsertRowid;entityEvent('contact',contactId,owner,'Контакт создан при быстром добавлении сделки')}
    const created=db.prepare('INSERT INTO deals (name,stage_id,company_id,contact_id,owner_id,amount,source,tags,description) VALUES (?,?,?,?,?,?,?,?,?)').run(name,stage,companyId,contactId,owner,money,value(req.body.source,255),value(req.body.tags,1000),value(req.body.description,10000));
    if(contactId)db.prepare('INSERT INTO deal_contacts (deal_id,contact_id) VALUES (?,?)').run(created.lastInsertRowid,contactId);
    event(created.lastInsertRowid,owner,'Сделка создана');runStageAutomation(created.lastInsertRowid,stage,owner,owner);
    return created.lastInsertRowid;
  })();
  res.status(201).json({id:dealId});
});
app.use('/api/deals/:id',auth,(req,res,next)=>{const id=int(req.params.id);if(!liveDeal(id))return fail(res,404,'Сделка не найдена');if(!dealAllowed(req,id))return fail(res,403,'Нет доступа к сделке');next()});
app.post('/api/deals/:id/duplicate',auth,requirePermission('deal','create'),(req,res)=>{
  const sourceId=int(req.params.id),source=db.prepare('SELECT * FROM deals WHERE id=? AND deleted_at IS NULL').get(sourceId);
  const stage=db.prepare("SELECT id FROM stages WHERE pipeline_id=(SELECT pipeline_id FROM stages WHERE id=?) AND kind='active' ORDER BY sort_order,id LIMIT 1").get(source.stage_id);
  if(!stage)return fail(res,409,'В воронке нет активного этапа');
  const contacts=dealContactsFor(req,sourceId),contactId=contacts.some(item=>item.id===source.contact_id)?source.contact_id:contacts[0]?.id||null;
  const companyId=source.company_id&&entityAllowed(req,'company',source.company_id)?source.company_id:null;
  const ownerId=ownDeals(req)?req.user.id:source.owner_id||req.user.id;
  const suffix=' (копия)',name=source.name.slice(0,255-suffix.length)+suffix;
  const id=db.transaction(()=>{
    const created=db.prepare('INSERT INTO deals (name,stage_id,company_id,contact_id,owner_id,amount,source,tags,description) VALUES (?,?,?,?,?,?,?,?,?)').run(name,stage.id,companyId,contactId,ownerId,source.amount,source.source,source.tags,source.description);
    const dealId=created.lastInsertRowid;
    const addContact=db.prepare('INSERT INTO deal_contacts (deal_id,contact_id) VALUES (?,?)');
    for(const contact of contacts)addContact.run(dealId,contact.id);
    db.prepare("INSERT INTO custom_field_values (field_id,entity_id,value) SELECT v.field_id,?,v.value FROM custom_field_values v JOIN custom_fields f ON f.id=v.field_id AND f.entity_type='deal' WHERE v.entity_id=?").run(dealId,sourceId);
    event(dealId,req.user.id,`Сделка создана как копия #${sourceId}`);
    runStageAutomation(dealId,stage.id,ownerId,req.user.id);
    return dealId;
  })();
  res.status(201).json({id});
});
const dealSelect=(req)=>`SELECT d.*,s.name stage_name,s.color stage_color,s.pipeline_id,s.kind,p.name pipeline_name,u.name owner_name,c.name contact_name,co.name company_name,co.phone company_phone,co.email company_email,co.website company_website,co.address company_address,
  (SELECT group_concat(linked.name,' ') FROM deal_contacts dc JOIN contacts linked ON linked.id=dc.contact_id AND linked.deleted_at IS NULL AND (${ownContacts(req)?1:0}=0 OR linked.owner_id=${req.user.id}) WHERE dc.deal_id=d.id) contact_names,
  (SELECT COUNT(*) FROM deal_contacts dc JOIN contacts linked ON linked.id=dc.contact_id AND linked.deleted_at IS NULL AND (${ownContacts(req)?1:0}=0 OR linked.owner_id=${req.user.id}) WHERE dc.deal_id=d.id) contact_count,
  (SELECT json_group_object(v.field_id,v.value) FROM custom_field_values v JOIN custom_fields f ON f.id=v.field_id AND f.entity_type='deal' WHERE v.entity_id=d.id) custom_values,
  (SELECT c.kind FROM deal_communications c WHERE c.deal_id=d.id ORDER BY c.id DESC LIMIT 1) last_communication_kind,
  (SELECT substr(COALESCE(NULLIF(c.subject,''),c.body),1,160) FROM deal_communications c WHERE c.deal_id=d.id ORDER BY c.id DESC LIMIT 1) last_communication_text,
  (SELECT COUNT(*) FROM tasks t WHERE t.deal_id=d.id AND t.deleted_at IS NULL AND t.completed_at IS NULL AND (${ownTasks(req)?1:0}=0 OR t.owner_id=${req.user.id})) open_tasks_count,
  (SELECT COUNT(*) FROM tasks t WHERE t.deal_id=d.id AND t.deleted_at IS NULL AND t.completed_at IS NULL AND datetime(t.due_at)<datetime('now') AND (${ownTasks(req)?1:0}=0 OR t.owner_id=${req.user.id})) overdue_tasks_count,
  (SELECT MIN(t.due_at) FROM tasks t WHERE t.deal_id=d.id AND t.deleted_at IS NULL AND t.completed_at IS NULL AND t.due_at IS NOT NULL AND (${ownTasks(req)?1:0}=0 OR t.owner_id=${req.user.id})) next_task_at
  FROM deals d JOIN stages s ON s.id=d.stage_id JOIN pipelines p ON p.id=s.pipeline_id LEFT JOIN users u ON u.id=d.owner_id LEFT JOIN contacts c ON c.id=d.contact_id AND c.deleted_at IS NULL AND (${ownContacts(req)?1:0}=0 OR c.owner_id=${req.user.id}) LEFT JOIN companies co ON co.id=d.company_id AND co.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR co.owner_id=${req.user.id})`;
app.get('/api/dashboard',auth,(req,res)=>{
  const from=value(req.query.from,10),to=value(req.query.to,10),scope=value(req.query.scope,10),q=value(req.query.q,120);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>=to||!['all','mine'].includes(scope))return fail(res,400,'Проверьте период рабочего стола');
  const owner=scope==='mine'||ownDeals(req)?req.user.id:null;
  const taskOwner=scope==='mine'||ownTasks(req)?req.user.id:null;
  const dealWhere=`d.deleted_at IS NULL${owner?' AND d.owner_id=?':''}`;
  const dealParams=()=>owner?[owner]:[];
  const taskWhere=`t.deleted_at IS NULL AND (t.deal_id IS NULL OR d.deleted_at IS NULL) AND (t.contact_id IS NULL OR c.id IS NOT NULL AND c.deleted_at IS NULL${ownContacts(req)?` AND c.owner_id=${req.user.id}`:''}) AND (t.company_id IS NULL OR co.id IS NOT NULL AND co.deleted_at IS NULL${ownCompanies(req)?` AND co.owner_id=${req.user.id}`:''})${taskOwner?' AND t.owner_id=?':''}${ownDeals(req)?' AND (t.deal_id IS NULL OR d.owner_id=?)':''}`;
  const taskParams=()=>[...(taskOwner?[taskOwner]:[]),...(ownDeals(req)?[req.user.id]:[])];
  const taskFrom=`FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id LEFT JOIN contacts c ON c.id=t.contact_id LEFT JOIN companies co ON co.id=t.company_id`;
  const taskCount=(condition,params=[])=>db.prepare(`SELECT COUNT(*) n ${taskFrom} WHERE ${taskWhere} AND ${condition}`).get(...taskParams(),...params).n;
  const overdue=taskCount("t.completed_at IS NULL AND t.due_at IS NOT NULL AND julianday(t.due_at)<julianday('now')");
  const completed=taskCount('t.completed_at IS NOT NULL AND date(t.completed_at)>=? AND date(t.completed_at)<?',[from,to]);
  const todo=taskCount('t.completed_at IS NULL AND t.due_at IS NOT NULL AND date(t.due_at)>=? AND date(t.due_at)<?',[from,to]);
  const without=db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(d.amount),0) amount FROM deals d JOIN stages s ON s.id=d.stage_id WHERE ${dealWhere} AND s.kind='active' AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.deal_id=d.id AND t.deleted_at IS NULL AND t.completed_at IS NULL${taskOwner?' AND t.owner_id=?':''})`).get(...dealParams(),...(taskOwner?[taskOwner]:[]));
  const sources=db.prepare(`SELECT COALESCE(NULLIF(TRIM(d.source),''),'Без источника') name,COUNT(*) count FROM deals d WHERE ${dealWhere} AND date(d.created_at)>=? AND date(d.created_at)<? GROUP BY 1 ORDER BY 2 DESC,1 COLLATE NOCASE LIMIT 6`).all(...dealParams(),from,to);
  const periodDealCount=db.prepare(`SELECT COUNT(*) n FROM deals d WHERE ${dealWhere} AND date(d.created_at)>=? AND date(d.created_at)<?`).get(...dealParams(),from,to).n;
  const managerRows=db.prepare(`SELECT d.owner_id id,COALESCE(u.name,'Другие') name,COUNT(*) count,COALESCE(SUM(d.amount),0) amount FROM deals d JOIN stages s ON s.id=d.stage_id LEFT JOIN users u ON u.id=d.owner_id WHERE ${dealWhere} AND s.kind='active' GROUP BY d.owner_id ORDER BY 4 DESC`).all(...dealParams());
  const pattern=`%${q}%`;
  const recent=db.prepare(`SELECT d.id,d.name,d.amount,d.source,d.created_at,s.name stage_name,u.name owner_name,c.name contact_name,co.name company_name FROM deals d JOIN stages s ON s.id=d.stage_id LEFT JOIN users u ON u.id=d.owner_id LEFT JOIN contacts c ON c.id=d.contact_id AND c.deleted_at IS NULL AND (${ownContacts(req)?1:0}=0 OR c.owner_id=${req.user.id}) LEFT JOIN companies co ON co.id=d.company_id AND co.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR co.owner_id=${req.user.id}) WHERE ${dealWhere} AND (d.name LIKE ? OR d.source LIKE ? OR c.name LIKE ? OR co.name LIKE ?) ORDER BY d.created_at DESC,d.id DESC LIMIT 6`).all(...dealParams(),pattern,pattern,pattern,pattern);
  const events=db.prepare(`SELECT t.id,t.title,t.due_at,d.name deal_name,c.name contact_name,co.name company_name ${taskFrom} WHERE ${taskWhere} AND t.completed_at IS NULL ORDER BY t.due_at IS NULL,t.due_at,t.id DESC LIMIT 12`).all(...taskParams());
  res.json({overdue,completed,todo,without,sources,periodDealCount,managerRows,recent,events});
});
app.get('/api/deals',auth,(req,res) => { const pid=int(req.query.pipeline_id), q=value(req.query.q,120), owner=int(req.query.owner_id); if (!pid) return fail(res,400,'Укажите воронку'); res.json(db.prepare(`${dealSelect(req)} WHERE d.deleted_at IS NULL AND s.pipeline_id=? AND (d.name LIKE ? OR co.name LIKE ? OR c.name LIKE ? OR EXISTS(SELECT 1 FROM deal_contacts dc JOIN contacts linked ON linked.id=dc.contact_id AND linked.deleted_at IS NULL AND (${ownContacts(req)?1:0}=0 OR linked.owner_id=${req.user.id}) WHERE dc.deal_id=d.id AND linked.name LIKE ?)) AND (? IS NULL OR d.owner_id=?) AND (?=0 OR d.owner_id=?) ORDER BY d.updated_at DESC,d.id DESC LIMIT 1000`).all(pid,`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`,owner,owner,ownDeals(req)?1:0,req.user.id)); });
app.get('/api/deals/:id',auth,(req,res) => { const deal=db.prepare(`${dealSelect(req)} WHERE d.id=? AND d.deleted_at IS NULL`).get(int(req.params.id)); if (!deal) return fail(res,404,'Сделка не найдена'); const relatedDeals=db.prepare('SELECT d.id,d.name,d.amount,d.updated_at,s.name stage_name,s.color stage_color,p.name pipeline_name,u.name owner_name FROM deals d JOIN stages s ON s.id=d.stage_id JOIN pipelines p ON p.id=s.pipeline_id LEFT JOIN users u ON u.id=d.owner_id WHERE d.deleted_at IS NULL AND d.id<>? AND ((? IS NOT NULL AND d.company_id=?) OR EXISTS(SELECT 1 FROM deal_contacts candidate JOIN deal_contacts linked ON linked.contact_id=candidate.contact_id WHERE candidate.deal_id=d.id AND linked.deal_id=?)) AND (?=0 OR d.owner_id=?) ORDER BY d.updated_at DESC,d.id DESC LIMIT 100').all(deal.id,deal.company_id,deal.company_id,deal.id,ownDeals(req)?1:0,req.user.id); const stageSince=db.prepare("SELECT created_at FROM activity WHERE deal_id=? AND event LIKE 'Этап изменён:%' ORDER BY id DESC LIMIT 1").get(deal.id)?.created_at||deal.created_at; res.json({...deal,stage_since:stageSince,contacts:dealContactsFor(req,deal.id),related_deals:relatedDeals,notes:db.prepare('SELECT n.*,u.name author FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE deal_id=? ORDER BY n.id DESC').all(deal.id),communications:db.prepare('SELECT c.*,u.name author FROM deal_communications c LEFT JOIN users u ON u.id=c.user_id WHERE c.deal_id=? ORDER BY c.id DESC').all(deal.id),activity:db.prepare('SELECT a.*,u.name author FROM activity a LEFT JOIN users u ON u.id=a.user_id WHERE deal_id=? ORDER BY a.id DESC LIMIT 100').all(deal.id),tasks:db.prepare('SELECT t.*,u.name owner_name FROM tasks t LEFT JOIN users u ON u.id=t.owner_id WHERE t.deal_id=? AND t.deleted_at IS NULL AND (?=0 OR t.owner_id=?) ORDER BY t.completed_at IS NOT NULL,t.due_at').all(deal.id,ownTasks(req)?1:0,req.user.id),custom_fields:customFieldsFor('deal',deal.id),attachments:attachmentsFor('deal',deal.id)}); });
app.post('/api/deals',auth,requirePermission('deal','create'),(req,res) => { const stage=int(req.body.stage_id), contact=int(req.body.contact_id), company=int(req.body.company_id), owner=int(req.body.owner_id)||req.user.id, money=amount(req.body.amount??0),reason=lossReason(req.body.loss_reason??''); if (!required(req.body.name,255)||!idExists('stages',stage)||money===null||reason===null||contact&&!idExists('contacts',contact)||company&&!idExists('companies',company)||!idExists('users',owner)) return fail(res,400,'Проверьте данные сделки'); if(ownDeals(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе'); if(!linkedEntityAllowed(req,contact,company))return fail(res,403,'Нет доступа к контакту или компании'); const r=db.transaction(()=>{const created=db.prepare('INSERT INTO deals (name,stage_id,contact_id,company_id,owner_id,amount,source,tags,description,loss_reason) VALUES (?,?,?,?,?,?,?,?,?,?)').run(req.body.name.trim(),stage,contact,company,owner,money,value(req.body.source,255),value(req.body.tags,1000),value(req.body.description,10000),stageKind(stage)==='lost'?reason:'');if(contact)db.prepare('INSERT OR IGNORE INTO deal_contacts (deal_id,contact_id) VALUES (?,?)').run(created.lastInsertRowid,contact);event(created.lastInsertRowid,req.user.id,'Сделка создана');runStageAutomation(created.lastInsertRowid,stage,owner,req.user.id);return created})(); res.status(201).json({id:r.lastInsertRowid}); });
app.patch('/api/deals/:id',auth,requirePermission('deal','edit'),(req,res)=>{
  const id=int(req.params.id),old=db.prepare('SELECT * FROM deals WHERE id=?').get(id);
  if(!old)return fail(res,404,'Сделка не найдена');
  const x={...old,...req.body},stage=int(x.stage_id),contact=int(x.contact_id),company=int(x.company_id),owner=int(x.owner_id),money=amount(x.amount),reason=lossReason(x.loss_reason);
  if(!required(x.name,255)||!idExists('stages',stage)||money===null||reason===null||contact&&contact!==old.contact_id&&!idExists('contacts',contact)||company&&company!==old.company_id&&!idExists('companies',company)||owner&&!idExists('users',owner))return fail(res,400,'Проверьте данные сделки');
  if(ownDeals(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе');
  if(contact!==old.contact_id&&contact&&!entityAllowed(req,'contact',contact)||company!==old.company_id&&company&&!entityAllowed(req,'company',company))return fail(res,403,'Нет доступа к контакту или компании');
  const savedReason=stageKind(stage)==='lost'?(stage!==old.stage_id&&req.body.loss_reason===undefined?'':reason):'';
  const saved={name:x.name.trim(),stage_id:stage,contact_id:contact,company_id:company,owner_id:owner,amount:money,source:value(x.source,255),tags:value(x.tags,1000),description:value(x.description,10000),loss_reason:savedReason};
  db.transaction(()=>{
    db.prepare("UPDATE deals SET name=?,stage_id=?,contact_id=?,company_id=?,owner_id=?,amount=?,source=?,tags=?,description=?,loss_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(saved.name,saved.stage_id,saved.contact_id,saved.company_id,saved.owner_id,saved.amount,saved.source,saved.tags,saved.description,saved.loss_reason,id);
    if(contact!==old.contact_id){
      if(contact)db.prepare('INSERT OR IGNORE INTO deal_contacts (deal_id,contact_id) VALUES (?,?)').run(id,contact);
      else if(old.contact_id){
        db.prepare('DELETE FROM deal_contacts WHERE deal_id=? AND contact_id=?').run(id,old.contact_id);
        const next=db.prepare('SELECT contact_id FROM deal_contacts WHERE deal_id=? ORDER BY created_at,contact_id LIMIT 1').get(id);
        db.prepare('UPDATE deals SET contact_id=? WHERE id=?').run(next?.contact_id||null,id);
      }
    }
    if(stage!==old.stage_id){
      const previous=db.prepare('SELECT s.pipeline_id FROM stages s WHERE s.id=?').get(old.stage_id);
      const current=db.prepare('SELECT s.name,s.pipeline_id,p.name pipeline_name FROM stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.id=?').get(stage);
      event(id,req.user.id,`Этап изменён: ${current.name}${previous.pipeline_id!==current.pipeline_id?` · Перенос в воронку «${current.pipeline_name}»`:''}${savedReason?` · ${savedReason}`:''}`);
      runStageAutomation(id,stage,owner,req.user.id);
    }else if(savedReason!==old.loss_reason)event(id,req.user.id,`Причина отказа: ${savedReason||'Без причины'}`);
    logDealChanges(id,req.user.id,old,db.prepare('SELECT * FROM deals WHERE id=?').get(id));
  })();
  res.json({ok:true});
});
app.post('/api/deals/:id/contacts',auth,requirePermission('deal','edit'),(req,res)=>{const dealId=int(req.params.id),contactId=int(req.body.contact_id),contact=db.prepare('SELECT id,name FROM contacts WHERE id=? AND deleted_at IS NULL').get(contactId);if(!contact||!entityAllowed(req,'contact',contactId))return fail(res,400,'Контакт не найден');if(db.prepare('SELECT 1 FROM deal_contacts WHERE deal_id=? AND contact_id=?').get(dealId,contactId))return fail(res,409,'Контакт уже связан со сделкой');db.transaction(()=>{db.prepare('INSERT INTO deal_contacts (deal_id,contact_id) VALUES (?,?)').run(dealId,contactId);if(!db.prepare('SELECT contact_id FROM deals WHERE id=?').get(dealId).contact_id)db.prepare('UPDATE deals SET contact_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(contactId,dealId);event(dealId,req.user.id,`Контакт добавлен: ${contact.name}`)})();res.status(201).json({ok:true})});
app.post('/api/deals/:id/contacts/new',auth,requirePermission('deal','edit'),requirePermission('contact','create'),(req,res)=>{
  if(!required(req.body?.name,255))return fail(res,400,'Укажите контакт');
  const dealId=int(req.params.id),deal=liveDeal(dealId);
  const company=deal.company_id&&entityAllowed(req,'company',deal.company_id)?deal.company_id:null;
  const saved={name:req.body.name.trim(),company_id:company,owner_id:req.user.id,phone:value(req.body.phone,80),email:value(req.body.email,254),position:value(req.body.position,255)};
  const id=db.transaction(()=>{
    const row=db.prepare('INSERT INTO contacts (name,company_id,owner_id,phone,email,position) VALUES (?,?,?,?,?,?)').run(saved.name,saved.company_id,saved.owner_id,saved.phone,saved.email,saved.position);
    const contactId=row.lastInsertRowid;
    entityEvent('contact',contactId,req.user.id,'Контакт создан');
    db.prepare('INSERT INTO deal_contacts (deal_id,contact_id) VALUES (?,?)').run(dealId,contactId);
    if(!deal.contact_id)db.prepare('UPDATE deals SET contact_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(contactId,dealId);
    event(dealId,req.user.id,`Контакт добавлен: ${saved.name}`);
    return contactId;
  })();
  res.status(201).json({id,deal_id:dealId});
});
app.delete('/api/deals/:id/contacts/:contactId',auth,requirePermission('deal','edit'),(req,res)=>{const dealId=int(req.params.id),contactId=int(req.params.contactId);if(!entityAllowed(req,'contact',contactId))return fail(res,404,'Контакт не связан со сделкой');const linked=db.prepare('SELECT c.name FROM deal_contacts dc JOIN contacts c ON c.id=dc.contact_id WHERE dc.deal_id=? AND dc.contact_id=?').get(dealId,contactId);if(!linked)return fail(res,404,'Контакт не связан со сделкой');db.transaction(()=>{db.prepare('DELETE FROM deal_contacts WHERE deal_id=? AND contact_id=?').run(dealId,contactId);if(db.prepare('SELECT contact_id FROM deals WHERE id=?').get(dealId).contact_id===contactId){const next=db.prepare('SELECT contact_id FROM deal_contacts WHERE deal_id=? ORDER BY created_at,contact_id LIMIT 1').get(dealId);db.prepare('UPDATE deals SET contact_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next?.contact_id||null,dealId)}event(dealId,req.user.id,`Контакт удалён из сделки: ${linked.name}`)})();res.json({ok:true})});
app.post('/api/deals/:id/communications',auth,requirePermission('deal','edit'),(req,res)=>{
  const id=int(req.params.id),kind=req.body?.kind,direction=req.body?.direction,subject=value(req.body?.subject,255),body=value(req.body?.body,10000);
  if(!['call','email','message'].includes(kind)||!['incoming','outgoing'].includes(direction)||!body)return fail(res,400,'Заполните запись о коммуникации');
  if(kind!=='email'&&subject)return fail(res,400,'Тема доступна только для письма');
  const row=db.prepare('INSERT INTO deal_communications (deal_id,user_id,kind,direction,subject,body) VALUES (?,?,?,?,?,?)').run(id,req.user.id,kind,direction,subject,body);
  res.status(201).json({id:row.lastInsertRowid});
});
app.post('/api/deals/:id/notes',auth,requirePermission('deal','edit'),(req,res) => { const id=int(req.params.id); if (!idExists('deals',id)||!required(req.body.body,10000)) return fail(res,400,'Введите заметку'); const r=db.prepare('INSERT INTO notes (deal_id,user_id,body) VALUES (?,?,?)').run(id,req.user.id,req.body.body.trim()); event(id,req.user.id,'Добавлена заметка'); res.status(201).json({id:r.lastInsertRowid}); });
app.patch('/api/deals/:id/notes/:noteId',auth,requirePermission('deal','edit'),(req,res)=>{
  const dealId=int(req.params.id),noteId=int(req.params.noteId);
  if(typeof req.body.pinned!=='boolean')return fail(res,400,'Укажите, нужно ли закрепить примечание');
  const note=db.prepare('SELECT id,pinned FROM notes WHERE id=? AND deal_id=?').get(noteId,dealId);
  if(!note)return fail(res,404,'Примечание не найдено');
  const pinned=req.body.pinned?1:0;
  if(note.pinned!==pinned){db.prepare('UPDATE notes SET pinned=? WHERE id=?').run(pinned,noteId);event(dealId,req.user.id,pinned?'Примечание закреплено':'Примечание откреплено')}
  res.json({id:noteId,pinned:!!pinned});
});
app.delete('/api/deals/:id',auth,requirePermission('deal','delete'),(req,res)=>{const id=int(req.params.id);db.transaction(()=>{event(id,req.user.id,'Сделка перемещена в корзину');db.prepare('UPDATE deals SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(id)})();res.json({ok:true})});
app.get('/api/tasks',auth,(req,res) => { const state=value(req.query.state,20); res.json(db.prepare(`SELECT t.*,d.name deal_name,c.name contact_name,dc.name deal_contact_name,COALESCE(co.name,dco.name,cco.name) company_name,s.name stage_name,s.color stage_color,u.name owner_name FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id LEFT JOIN contacts c ON c.id=t.contact_id AND c.deleted_at IS NULL AND (${ownContacts(req)?1:0}=0 OR c.owner_id=${req.user.id}) LEFT JOIN contacts dc ON dc.id=d.contact_id AND dc.deleted_at IS NULL AND (${ownContacts(req)?1:0}=0 OR dc.owner_id=${req.user.id}) LEFT JOIN companies co ON co.id=t.company_id AND co.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR co.owner_id=${req.user.id}) LEFT JOIN companies dco ON dco.id=d.company_id AND dco.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR dco.owner_id=${req.user.id}) LEFT JOIN companies cco ON cco.id=c.company_id AND cco.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR cco.owner_id=${req.user.id}) LEFT JOIN stages s ON s.id=d.stage_id LEFT JOIN users u ON u.id=t.owner_id WHERE t.deleted_at IS NULL AND (t.deal_id IS NULL OR d.deleted_at IS NULL) AND (t.contact_id IS NULL OR c.id IS NOT NULL) AND (t.company_id IS NULL OR co.id IS NOT NULL) AND (?='all' OR (?='done' AND t.completed_at IS NOT NULL) OR (? NOT IN ('all','done') AND t.completed_at IS NULL)) AND (?=0 OR t.owner_id=?) AND (?=0 OR t.deal_id IS NULL OR d.owner_id=?) ORDER BY t.completed_at IS NOT NULL,t.due_at IS NULL,t.due_at,t.id DESC LIMIT 1000`).all(state,state,state,ownTasks(req)?1:0,req.user.id,ownDeals(req)?1:0,req.user.id)); });
app.post('/api/tasks',auth,requirePermission('task','create'),(req,res) => { const deal=int(req.body.deal_id),contact=int(req.body.contact_id),company=int(req.body.company_id),owner=int(req.body.owner_id)||req.user.id; if (!required(req.body.title,500)||deal&&!idExists('deals',deal)||contact&&!idExists('contacts',contact)||company&&!idExists('companies',company)||company&&(deal||contact)||!idExists('users',owner)) return fail(res,400,'Проверьте задачу'); if(ownTasks(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе');if(deal&&!dealAllowed(req,deal))return fail(res,403,'Нет доступа к сделке');if(!linkedEntityAllowed(req,contact,company))return fail(res,403,'Нет доступа к контакту или компании');const schedule=taskSchedule(req.body);if(!schedule)return fail(res,400,'Проверьте срок задачи'); const r=db.prepare('INSERT INTO tasks (title,task_type,due_at,duration_minutes,all_day,deal_id,contact_id,company_id,owner_id) VALUES (?,?,?,?,?,?,?,?,?)').run(req.body.title.trim(),value(req.body.task_type,50)||'Связаться',schedule.due_at,schedule.duration_minutes,schedule.all_day,deal,contact,company,owner); if (deal) event(deal,req.user.id,'Задача создана'); res.status(201).json({id:r.lastInsertRowid}); });
app.post('/api/tasks/bulk',auth,(req,res)=>{
  const ids=req.body.ids,action=req.body.action;
  if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>!Number.isInteger(id)||id<1)||new Set(ids).size!==ids.length||!['complete','delete','owner','date','type'].includes(action))return fail(res,400,'Проверьте выбранные задачи');
  if(!allowed(req,'task',action==='delete'?'delete':'edit'))return fail(res,403,'Нет прав на изменение задач');
  const tasks=db.prepare(`SELECT id,deal_id,contact_id,company_id,owner_id,completed_at,due_at,duration_minutes,all_day FROM tasks WHERE deleted_at IS NULL AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
  if(tasks.length!==ids.length)return fail(res,404,'Одна из задач не найдена');
  if(tasks.some(task=>!taskAllowed(req,task)||task.deal_id&&!dealAllowed(req,task.deal_id)||!linkedEntityAllowed(req,task.contact_id,task.company_id)))return fail(res,403,'Нет доступа к одной из задач');
  const owner=int(req.body.owner_id),type=value(req.body.task_type,50),result=value(req.body.result,5000),schedule=action==='date'?taskSchedule(req.body):null;
  if(action==='owner'&&(!idExists('users',owner)||ownTasks(req)&&owner!==req.user.id)||action==='type'&&!required(type,50)||action==='date'&&(!schedule||!schedule.due_at)||action==='complete'&&(!required(result,5000)||tasks.some(task=>task.completed_at)))return fail(res,400,'Проверьте массовое действие');
  db.transaction(()=>{for(const task of tasks){
    if(action==='delete'){db.prepare('UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(task.id);if(task.deal_id)event(task.deal_id,req.user.id,'Задача перемещена в корзину')}
    if(action==='complete'){db.prepare('UPDATE tasks SET completed_at=?,completion_result=? WHERE id=?').run(new Date().toISOString(),result.trim(),task.id);if(task.deal_id)event(task.deal_id,req.user.id,`Задача выполнена: ${result.trim()}`)}
    if(action==='owner')db.prepare('UPDATE tasks SET owner_id=? WHERE id=?').run(owner,task.id);
    if(action==='type')db.prepare('UPDATE tasks SET task_type=? WHERE id=?').run(type.trim(),task.id);
    if(action==='date')db.prepare('UPDATE tasks SET due_at=?,duration_minutes=?,all_day=? WHERE id=?').run(schedule.due_at,schedule.duration_minutes,schedule.all_day,task.id);
  }})()
  res.json({ok:true,count:tasks.length});
});
app.patch('/api/tasks/:id',auth,requirePermission('task','edit'),(req,res) => { const id=int(req.params.id),old=db.prepare('SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL').get(id); if (!old) return fail(res,404,'Задача не найдена'); if(!taskAllowed(req,old)||old.deal_id&&!dealAllowed(req,old.deal_id)||!linkedEntityAllowed(req,old.contact_id,old.company_id))return fail(res,403,'Нет доступа к задаче');const x={...old,...req.body},owner=int(x.owner_id),deal=int(x.deal_id),contact=int(x.contact_id),company=int(x.company_id); if (!required(x.title,500)||owner&&!idExists('users',owner)||deal&&!idExists('deals',deal)||contact&&contact!==old.contact_id&&!idExists('contacts',contact)||company&&company!==old.company_id&&!idExists('companies',company)||company&&(deal||contact)) return fail(res,400,'Проверьте задачу');if(ownTasks(req)&&owner!==req.user.id)return fail(res,403,'Можно назначать только себе');if(deal&&!dealAllowed(req,deal))return fail(res,403,'Нет доступа к сделке');if(!linkedEntityAllowed(req,contact,company))return fail(res,403,'Нет доступа к контакту или компании'); const result=req.body.completed===true?value(req.body.result,5000):req.body.completed===false?'':old.completion_result;if(req.body.completed===true&&!required(req.body.result,5000))return fail(res,400,'Укажите результат задачи');const completed=req.body.completed===true?new Date().toISOString():req.body.completed===false?null:old.completed_at,schedule=taskSchedule(x);if(!schedule)return fail(res,400,'Проверьте срок задачи'); db.prepare('UPDATE tasks SET title=?,task_type=?,due_at=?,duration_minutes=?,all_day=?,owner_id=?,deal_id=?,contact_id=?,company_id=?,completed_at=?,completion_result=? WHERE id=?').run(x.title.trim(),value(x.task_type,50)||'Связаться',schedule.due_at,schedule.duration_minutes,schedule.all_day,owner,deal,contact,company,completed,result,id); if (deal && req.body.completed!==undefined) event(deal,req.user.id,completed?`Задача выполнена: ${result}`:'Задача возвращена в работу'); res.json({ok:true,completion_result:result}); });
app.get('/api/trash/tasks',auth,(req,res)=>res.json(db.prepare('SELECT t.id,t.title name,t.deleted_at,t.owner_id,t.deal_id,u.name owner_name FROM tasks t LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN deals d ON d.id=t.deal_id WHERE t.deleted_at IS NOT NULL AND (?=0 OR t.owner_id=?) AND (?=0 OR t.deal_id IS NULL OR d.owner_id=?) ORDER BY t.deleted_at DESC,t.id DESC LIMIT 500').all(ownTasks(req)?1:0,req.user.id,ownDeals(req)?1:0,req.user.id)));
app.delete('/api/tasks/:id',auth,requirePermission('task','delete'),(req,res)=>{const id=int(req.params.id),task=db.prepare('SELECT id,owner_id,deal_id,contact_id,company_id FROM tasks WHERE id=? AND deleted_at IS NULL').get(id);if(!task)return fail(res,404,'Задача не найдена');if(!taskAllowed(req,task)||task.deal_id&&!dealAllowed(req,task.deal_id)||!linkedEntityAllowed(req,task.contact_id,task.company_id))return fail(res,403,'Нет доступа к задаче');db.prepare('UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(id);if(task.deal_id)event(task.deal_id,req.user.id,'Задача перемещена в корзину');res.json({ok:true})});
app.post('/api/tasks/:id/restore',auth,requirePermission('task','create'),(req,res)=>{const id=int(req.params.id),task=db.prepare('SELECT id,owner_id,deal_id,contact_id,company_id FROM tasks WHERE id=? AND deleted_at IS NOT NULL').get(id);if(!task)return fail(res,404,'Задача не найдена в корзине');if(!taskAllowed(req,task)||task.deal_id&&!dealAllowed(req,task.deal_id)||!linkedEntityAllowed(req,task.contact_id,task.company_id))return fail(res,403,'Нет доступа к задаче');db.prepare('UPDATE tasks SET deleted_at=NULL WHERE id=?').run(id);if(task.deal_id)event(task.deal_id,req.user.id,'Задача восстановлена');res.json({ok:true})});
app.get('/api/stats',auth,(req,res) => { const pid=int(req.query.pipeline_id),dealScope=ownDeals(req)?1:0,taskScope=ownTasks(req)?1:0; const totals=db.prepare('SELECT COUNT(*) count,COALESCE(SUM(d.amount),0) amount FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND s.pipeline_id=? AND s.kind=? AND (?=0 OR d.owner_id=?)');const tasks=`FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id LEFT JOIN contacts c ON c.id=t.contact_id LEFT JOIN companies co ON co.id=t.company_id WHERE t.deleted_at IS NULL AND t.completed_at IS NULL AND (t.deal_id IS NULL OR d.deleted_at IS NULL) AND (t.contact_id IS NULL OR c.deleted_at IS NULL${ownContacts(req)?` AND c.owner_id=${req.user.id}`:''}) AND (t.company_id IS NULL OR co.deleted_at IS NULL${ownCompanies(req)?` AND co.owner_id=${req.user.id}`:''}) AND (?=0 OR t.owner_id=?) AND (?=0 OR t.deal_id IS NULL OR d.owner_id=?)`;res.json({active:totals.get(pid,'active',dealScope,req.user.id),won:totals.get(pid,'won',dealScope,req.user.id),lost:totals.get(pid,'lost',dealScope,req.user.id),overdue:db.prepare(`SELECT COUNT(*) n ${tasks} AND datetime(t.due_at)<datetime('now')`).get(taskScope,req.user.id,dealScope,req.user.id).n,upcoming:db.prepare(`SELECT COUNT(*) n ${tasks}`).get(taskScope,req.user.id,dealScope,req.user.id).n}); });
app.get('/api/analytics',auth,(req,res) => {
  if(ownDeals(req)||ownTasks(req))return fail(res,403,'Аналитика доступна только при полном доступе к сделкам и задачам');
  const pid=int(req.query.pipeline_id),from=req.query.from,to=req.query.to;
  if(!idExists('pipelines',pid)||typeof from!=='string'||typeof to!=='string'||!/^(\d{4})-(\d{2})-(\d{2})$/.test(from)||!/^(\d{4})-(\d{2})-(\d{2})$/.test(to)||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||from>to||Date.parse(to)-Date.parse(from)>366*864e5)return fail(res,400,'Проверьте период аналитики');
  const range=[from,to];
  const stageRows=db.prepare('SELECT s.id,s.name,s.color,s.kind,s.sort_order,COUNT(d.id) count,COALESCE(SUM(d.amount),0) amount FROM stages s LEFT JOIN deals d ON d.stage_id=s.id AND d.deleted_at IS NULL WHERE s.pipeline_id=? GROUP BY s.id ORDER BY s.sort_order,s.id').all(pid);
  const created=db.prepare('SELECT substr(d.created_at,1,10) day,COUNT(*) count,COALESCE(SUM(d.amount),0) amount FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND s.pipeline_id=? AND substr(d.created_at,1,10) BETWEEN ? AND ? GROUP BY day ORDER BY day').all(pid,...range);
  const newDeals=db.prepare('SELECT COUNT(*) count,COALESCE(SUM(d.amount),0) amount FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND s.pipeline_id=? AND substr(d.created_at,1,10) BETWEEN ? AND ?').get(pid,...range);
  const people=db.prepare(`SELECT u.id,u.name,
    (SELECT COUNT(*) FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND d.owner_id=u.id AND s.pipeline_id=? AND s.kind='active') active_deals,
    (SELECT COUNT(*) FROM notes n JOIN deals d ON d.id=n.deal_id JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND n.user_id=u.id AND s.pipeline_id=? AND substr(n.created_at,1,10) BETWEEN ? AND ?) notes_added,
    (SELECT COUNT(*) FROM tasks t JOIN deals d ON d.id=t.deal_id JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND t.deleted_at IS NULL AND t.owner_id=u.id AND t.completed_at IS NULL AND s.pipeline_id=?) open_tasks,
    (SELECT COALESCE(SUM(d.amount),0) FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND d.owner_id=u.id AND s.pipeline_id=? AND s.kind='won') won_amount
    FROM users u ORDER BY u.name`).all(pid,pid,...range,pid,pid);
  const events=db.prepare('SELECT a.id,a.event,a.created_at,a.deal_id,d.name deal_name,u.name author FROM activity a JOIN deals d ON d.id=a.deal_id JOIN stages s ON s.id=d.stage_id LEFT JOIN users u ON u.id=a.user_id WHERE d.deleted_at IS NULL AND s.pipeline_id=? AND substr(a.created_at,1,10) BETWEEN ? AND ? ORDER BY a.id DESC LIMIT 100').all(pid,...range);
  const sources=db.prepare("SELECT COALESCE(NULLIF(trim(d.source),''),'Без источника') name,COUNT(*) count FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND s.pipeline_id=? GROUP BY 1 ORDER BY count DESC,name LIMIT 10").all(pid);
  const contacts=db.prepare('SELECT COUNT(*) n FROM contacts WHERE deleted_at IS NULL AND substr(created_at,1,10) BETWEEN ? AND ?').get(...range).n;
  res.json({from,to,stages:stageRows,created,new_deals:newDeals,people,events,sources,new_contacts:contacts});
});
app.get('/api/export/deals.csv',auth,requirePermission('deal','export'),(req,res) => { const rows=db.prepare(`${dealSelect(req)} WHERE d.deleted_at IS NULL AND (?=0 OR d.owner_id=?) ORDER BY d.id`).all(ownDeals(req)?1:0,req.user.id); const fields=['id','name','stage_name','loss_reason','amount','company_name','contact_name','owner_name','source','tags','description']; res.type('text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="deals.csv"').send('\uFEFF'+[fields.join(','),...rows.map(r=>fields.map(f=>quoteCsvCell(r[f])).join(','))].join('\r\n')); });
app.post('/api/import/deals.csv',auth,requirePermission('deal','create'),(req,res) => {
  const pid=int(req.body.pipeline_id);
  if(!idExists('pipelines',pid)||typeof req.body.csv!=='string'||req.body.csv.length>900000)return fail(res,400,'Неверный CSV или воронка');
  let rows;try{rows=parseCsv(req.body.csv)}catch(e){return fail(res,400,e.message)}
  if(rows.length<2)return fail(res,400,'CSV должен содержать заголовок и хотя бы одну строку');
  const aliases={name:['name','название','название сделки','сделка'],stage:['stage_name','этап','статус'],lossReason:['loss_reason','причина отказа'],amount:['amount','бюджет','сумма','цена'],company:['company_name','компания'],contact:['contact_name','контакт'],owner:['owner_name','ответственный'],source:['source','источник'],tags:['tags','теги'],description:['description','описание']};
  const header=rows[0].map(x=>x.trim().toLowerCase());
  const index=Object.fromEntries(Object.entries(aliases).map(([key,names])=>[key,header.findIndex(h=>names.includes(h))]));
  if(index.name<0)return fail(res,400,'В CSV нужна колонка name или «Название сделки»');
  const getCompany=db.prepare(`SELECT id FROM companies WHERE deleted_at IS NULL AND lower(name)=lower(?)${ownCompanies(req)?` AND owner_id=${req.user.id}`:''} LIMIT 1`);
  const getContact=db.prepare(`SELECT id FROM contacts WHERE deleted_at IS NULL AND lower(name)=lower(?) AND company_id IS ?${ownContacts(req)?` AND owner_id=${req.user.id}`:''} LIMIT 1`);
  if(index.company>=0&&!allowed(req,'company','create')&&rows.slice(1).some(row=>String(row[index.company]||'').trim()&&!getCompany.get(String(row[index.company]).trim())))return fail(res,403,'Нет прав на создание компании');
  if(index.contact>=0&&!allowed(req,'contact','create')&&rows.slice(1).some(row=>{const name=String(row[index.contact]||'').trim();if(!name)return false;const companyName=index.company<0?'':String(row[index.company]||'').trim();const companyId=companyName?getCompany.get(companyName)?.id:null;return companyName&&!companyId||!getContact.get(name,companyId)}))return fail(res,403,'Нет прав на создание контакта');
  const stages=db.prepare('SELECT id,name,kind FROM stages WHERE pipeline_id=? ORDER BY sort_order').all(pid);
  const insertDeal=db.prepare('INSERT INTO deals (name,stage_id,company_id,contact_id,owner_id,amount,source,tags,description,loss_reason) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const addCompany=db.prepare('INSERT INTO companies (name,owner_id) VALUES (?,?)');
  const addContact=db.prepare('INSERT INTO contacts (name,company_id,owner_id) VALUES (?,?,?)');
  const getOwner=db.prepare('SELECT id FROM users WHERE lower(name)=lower(?) LIMIT 1');
  const imported=db.transaction(()=>{let count=0;for(const row of rows.slice(1)){
    const col=key=>index[key]<0?'':String(row[index[key]]||'').trim();
    const name=col('name').slice(0,255);if(!name)continue;
    const stage=stages.find(s=>s.name.toLowerCase()===col('stage').toLowerCase())||stages[0];
    const rawAmount=col('amount').replace(/[\s\u00a0₽]/g,'').replace(',','.');const moneyValue=Math.round(Number(rawAmount||0));
    if(!Number.isSafeInteger(moneyValue)||moneyValue<0)continue;
    const owner=ownDeals(req)?req.user.id:(getOwner.get(col('owner'))?.id||req.user.id);
    let company=null,contact=null;
    if(col('company'))company=getCompany.get(col('company'))?.id||(()=>{const created=addCompany.run(col('company').slice(0,255),ownCompanies(req)?req.user.id:owner).lastInsertRowid;entityEvent('company',created,req.user.id,'Компания импортирована из CSV');return created})();
    if(col('contact'))contact=getContact.get(col('contact'),company)?.id||(()=>{const created=addContact.run(col('contact').slice(0,255),company,ownContacts(req)?req.user.id:owner).lastInsertRowid;entityEvent('contact',created,req.user.id,'Контакт импортирован из CSV');return created})();
    const result=insertDeal.run(name,stage.id,company,contact,owner,moneyValue,col('source').slice(0,255),col('tags').slice(0,1000),col('description').slice(0,10000),stage.kind==='lost'?col('lossReason').slice(0,120):'');
    if(contact)db.prepare('INSERT OR IGNORE INTO deal_contacts (deal_id,contact_id) VALUES (?,?)').run(result.lastInsertRowid,contact);event(result.lastInsertRowid,req.user.id,'Сделка импортирована из CSV');count++;
  }return count});
  const count=imported();res.json({imported:count,skipped:rows.length-1-count});
});
const entityCsv={contacts:{table:'contacts',fields:['id','name','company_name','position','phone','email','notes','tags','owner_name','created_at'],aliases:{name:['name','имя','имя контакта','контакт'],company:['company_name','компания'],position:['position','должность'],phone:['phone','телефон'],email:['email','почта','e-mail'],notes:['notes','примечание','описание'],tags:['tags','теги'],owner:['owner_name','ответственный']}},companies:{table:'companies',fields:['id','name','website','phone','email','notes','tags','owner_name','created_at'],aliases:{name:['name','название','название компании','компания'],website:['website','сайт'],phone:['phone','телефон'],email:['email','почта','e-mail'],notes:['notes','примечание','описание'],tags:['tags','теги'],owner:['owner_name','ответственный']}}};
app.get('/api/export/:kind.csv',auth,(req,res)=>{
  const config=entityCsv[req.params.kind];if(!config)return fail(res,404,'Неизвестный список');
  if(!allowed(req,config.table==='contacts'?'contact':'company','export'))return fail(res,403,'Нет прав на это действие');
  const rows=req.params.kind==='contacts'?db.prepare(`SELECT c.*,co.name company_name,u.name owner_name FROM contacts c LEFT JOIN companies co ON co.id=c.company_id AND co.deleted_at IS NULL AND (${ownCompanies(req)?1:0}=0 OR co.owner_id=${req.user.id}) LEFT JOIN users u ON u.id=c.owner_id WHERE c.deleted_at IS NULL AND (?=0 OR c.owner_id=?) ORDER BY c.id`).all(ownContacts(req)?1:0,req.user.id):db.prepare('SELECT co.*,u.name owner_name FROM companies co LEFT JOIN users u ON u.id=co.owner_id WHERE co.deleted_at IS NULL AND (?=0 OR co.owner_id=?) ORDER BY co.id').all(ownCompanies(req)?1:0,req.user.id);
  res.type('text/csv; charset=utf-8').set('Content-Disposition',`attachment; filename="${req.params.kind}.csv"`).send('\uFEFF'+[config.fields.join(','),...rows.map(row=>config.fields.map(field=>quoteCsvCell(row[field])).join(','))].join('\r\n'));
});
app.post('/api/import/:kind.csv',auth,(req,res)=>{
  const config=entityCsv[req.params.kind];if(!config)return fail(res,404,'Неизвестный список');
  if(!allowed(req,config.table==='contacts'?'contact':'company','create'))return fail(res,403,'Нет прав на это действие');
  if(typeof req.body.csv!=='string'||req.body.csv.length>900000)return fail(res,400,'Неверный CSV');
  let rows;try{rows=parseCsv(req.body.csv)}catch(error){return fail(res,400,error.message)}
  if(rows.length<2)return fail(res,400,'CSV должен содержать заголовок и хотя бы одну строку');
  const header=rows[0].map(column=>column.trim().toLowerCase());
  const index=Object.fromEntries(Object.entries(config.aliases).map(([key,names])=>[key,header.findIndex(column=>names.includes(column))]));
  if(index.name<0)return fail(res,400,'В CSV нужна колонка name или название записи');
  if(req.params.kind==='contacts'&&index.company>=0&&!allowed(req,'company','create')&&rows.slice(1).some(row=>String(row[index.company]||'').trim()&&!db.prepare(`SELECT id FROM companies WHERE deleted_at IS NULL AND lower(name)=lower(?)${ownCompanies(req)?` AND owner_id=${req.user.id}`:''} LIMIT 1`).get(String(row[index.company]).trim())))return fail(res,403,'Нет прав на создание компании');
  const getCompany=db.prepare(`SELECT id FROM companies WHERE deleted_at IS NULL AND lower(name)=lower(?)${ownCompanies(req)?` AND owner_id=${req.user.id}`:''} LIMIT 1`);
  const addCompany=db.prepare('INSERT INTO companies (name,owner_id) VALUES (?,?)');
  const addContact=db.prepare('INSERT INTO contacts (name,company_id,owner_id,position,phone,email,notes,tags) VALUES (?,?,?,?,?,?,?,?)');
  const addCompanyFull=db.prepare('INSERT INTO companies (name,owner_id,website,phone,email,notes,tags) VALUES (?,?,?,?,?,?,?)');
  const getOwner=db.prepare('SELECT id FROM users WHERE lower(name)=lower(?) ORDER BY id LIMIT 1');
  const imported=db.transaction(()=>{let count=0;for(const row of rows.slice(1)){
    const col=key=>index[key]<0?'':String(row[index[key]]||'').trim();
    const name=col('name');if(!name||name.length>255)continue;
    const email=col('email');if(email.length>254)continue;
    const owner=(req.params.kind==='contacts'?ownContacts(req):ownCompanies(req))?req.user.id:(getOwner.get(col('owner'))?.id||req.user.id);
    if(req.params.kind==='contacts'){
      const companyName=col('company');if(companyName.length>255)continue;
      const companyId=companyName?(getCompany.get(companyName)?.id||(()=>{const created=addCompany.run(companyName,ownCompanies(req)?req.user.id:owner).lastInsertRowid;entityEvent('company',created,req.user.id,'Компания импортирована из CSV');return created})()):null;
      const created=addContact.run(name,companyId,owner,col('position').slice(0,255),col('phone').slice(0,80),email,col('notes').slice(0,5000),col('tags').slice(0,1000)).lastInsertRowid;entityEvent('contact',created,req.user.id,'Контакт импортирован из CSV');
    }else{const created=addCompanyFull.run(name,owner,col('website').slice(0,255),col('phone').slice(0,80),email,col('notes').slice(0,5000),col('tags').slice(0,1000)).lastInsertRowid;entityEvent('company',created,req.user.id,'Компания импортирована из CSV')}
    count++;
  }return count})();
  res.json({imported,skipped:rows.length-1-imported});
});
registerIntegrations(app,db,{auth,admin,event,runStageAutomation});
app.use(express.static(resolve(root,'dist')));
app.get('/{*path}',(req,res) => { if (req.path.startsWith('/api/')) return fail(res,404,'Маршрут не найден'); res.sendFile(resolve(root,'dist/index.html')); });
app.use((err,_req,res,_next) => { console.error(err); fail(res,500,'Ошибка сервера'); });
if (process.env.NODE_ENV !== 'test') { const port=Number(process.env.PORT)||3001,host=process.env.HOST||'127.0.0.1'; app.listen(port,host,()=>console.log(`OpenCRM: http://${host}:${port}`)); }
export { app, db };
