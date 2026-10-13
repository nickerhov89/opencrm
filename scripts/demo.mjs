import {createServer} from 'node:http';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
if(!existsSync(join(root,'dist/index.html'))){console.error('Сначала соберите интерфейс: npm run build');process.exit(1)}

const folder=mkdtempSync(join(tmpdir(),'opencrm-demo-'));
process.env.DATABASE_PATH=join(folder,'demo.db');
process.env.UPLOAD_DIR=join(folder,'uploads');
process.env.NODE_ENV='test';

const {app,db}=await import('../server/index.js');
const upstream=app.listen(0,'127.0.0.1');
await new Promise(resolve=>upstream.once('listening',resolve));
const base=`http://127.0.0.1:${upstream.address().port}`;
let cookie='';

async function api(path,method='GET',body){
  const response=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body?JSON.stringify(body):undefined});
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  if(!response.ok)throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function seed(){
  const admin=await api('/setup','POST',{name:'Демо администратор',email:'admin@demo.example',password:'demo-only-local-password'});
  await api('/settings','PATCH',{name:'Демо CRM'});
  const sales=await api('/user-groups','POST',{name:'Отдел продаж'});
  const team=[
    await api('/users','POST',{name:'Анна Сергеева',email:'anna@demo.example',password:'demo-only-local-password',role:'member',group_id:sales.id}),
    await api('/users','POST',{name:'Илья Морозов',email:'ilya@demo.example',password:'demo-only-local-password',role:'member',group_id:sales.id})
  ];
  const pipeline=(await api('/pipelines'))[0];
  const stages=await api('/stages?pipeline_id='+pipeline.id);
  await api('/pipelines','POST',{name:'Повторные продажи'});
  const companyNames=['Вектор Диджитал','Норд Студио','Городские сервисы','Новая Линия','Альфа Лаб','Пиксель Про','Точка Роста','Меридиан','Бизнес Платформа','Техно Сфера','Зелёный Дом','Квант Медиа','Северный Проект','Форма Групп','Авангард ИТ','Креатив Парк','Старт Консалт','Белый Квадрат'];
  const firstNames=['Мария','Алексей','Елена','Дмитрий','Ольга','Павел','Наталья','Игорь','Дарья','Сергей','Анна','Роман','Ирина','Андрей','Светлана','Никита','Татьяна','Максим'];
  const lastNames=['Иванова','Петров','Соколова','Орлов','Кузнецова','Миронов','Беляева','Фёдоров','Зайцева','Волков','Морозова','Громов','Сидорова','Смирнов','Новикова','Егоров','Лебедева','Борисов'];
  const companies=[],contacts=[];
  for(let index=0;index<companyNames.length;index++){
    const owner=index%2?team[0]:team[1];
    const company=await api('/companies','POST',{name:companyNames[index],owner_id:owner.id,website:`https://company-${index+1}.example`,phone:`+7 000 100-00-${String(index+1).padStart(2,'0')}`,email:`hello@company-${index+1}.example`,tags:index%4===0?'Ключевой клиент':index%4===1?'Партнёр':''});
    companies.push(company);
    contacts.push(await api('/contacts','POST',{name:`${firstNames[index]} ${lastNames[index]}`,company_id:company.id,owner_id:owner.id,position:index%3===0?'Генеральный директор':index%3===1?'Маркетинг-директор':'Руководитель продаж',phone:`+7 000 000-00-${String(index+1).padStart(2,'0')}`,email:`person-${index+1}@demo.example`,tags:index%3===0?'ЛПР':index%3===1?'Маркетинг':'Продажи'}));
  }
  const titles=['Внедрение системы продаж','Аудит лидогенерации','Новая воронка заявок','Пилот AI-ассистента','Автоматизация CRM','Исследование рынка','Outbound-кампания','Обновление сайта','Контент-система','Настройка аналитики','Интеграция заявок','Программа партнёров','Пакет маркетинга','Серия встреч','Тестовый запуск','Рост конверсии','Обработка обращений','Стратегическая сессия'];
  const activeStages=stages.filter(stage=>stage.kind==='active');
  const deals=[];
  for(let index=0;index<titles.length;index++){
    const owner=index%2?team[0]:team[1];
    deals.push(await api('/deals','POST',{name:titles[index],stage_id:activeStages[index%activeStages.length].id,company_id:companies[index].id,contact_id:contacts[index].id,owner_id:owner.id,amount:35000+index*8500,source:['Сайт','Рекомендация','Вебинар','Исходящий'][index%4],tags:index%3===0?'Приоритет, Пилот':index%3===1?'Тёплый лид':'Партнёр'}));
  }
  const projectType=await api('/custom-fields','POST',{entity_type:'deal',name:'Тип проекта',field_type:'select',options:['Консалтинг','Автоматизация','Аналитика']});
  for(let index=0;index<deals.length;index++)await api(`/custom-fields/${projectType.id}/values/${deals[index].id}`,'PUT',{value:['Консалтинг','Автоматизация','Аналитика'][index%3]});
  await api('/deals','POST',{name:'Продолжение проекта',stage_id:activeStages[2].id,company_id:companies[0].id,contact_id:contacts[0].id,owner_id:team[1].id,amount:98000,source:'Повторное обращение',tags:'Повторная сделка'});
  await api('/deals/'+deals[0].id+'/contacts','POST',{contact_id:contacts[1].id});
  await api('/deals/'+deals[14].id,'PATCH',{stage_id:stages.find(stage=>stage.kind==='won').id});
  await api('/deals/'+deals[15].id,'PATCH',{stage_id:stages.find(stage=>stage.kind==='lost').id,loss_reason:'Дорого'});
  for(let index=0;index<9;index++){
    const scheduled=new Date(Date.now()+(index-2)*86400000),allDay=index===5;
    if(allDay)scheduled.setHours(23,59,0,0);
    const task=await api('/tasks','POST',{title:['Обсудить условия','Отправить предложение','Провести демонстрацию'][index%3],task_type:index%3===2?'Встреча':index%3===1?'Письмо':'Связаться',deal_id:deals[index].id,owner_id:index%2?team[0].id:team[1].id,due_at:scheduled.toISOString(),duration_minutes:index%3===2&&!allDay?30:0,all_day:allDay});
    if(index===0)await api('/tasks/'+task.id,'PATCH',{completed:true,result:'Клиент подтвердил интерес, договорились подготовить расчёт.'});
  }
  const today=new Date(),tomorrow=new Date(today.getFullYear(),today.getMonth(),today.getDate()+1,10),nextMonday=new Date(today.getFullYear(),today.getMonth(),today.getDate()+((8-today.getDay())%7||7),10),future=new Date(today.getFullYear(),today.getMonth()+2,3,10);
  const extra=[...Array.from({length:10},(_,index)=>new Date(tomorrow.getTime()+index*30*60000)),...Array.from({length:5},(_,index)=>new Date(nextMonday.getTime()+index*86400000)),...Array.from({length:5},(_,index)=>new Date(future.getTime()+index*86400000))];
  const extraTitles=['Уточнить сроки','Подготовить расчёт','Отправить кейсы','Согласовать встречу','Проверить договор','Обсудить пилот','Позвонить клиенту','Вернуться с предложением'];
  for(let index=0;index<extra.length;index++)await api('/tasks','POST',{title:extraTitles[index%extraTitles.length],task_type:index%5===3?'Встреча':'Связаться',deal_id:deals[(index+3)%deals.length].id,owner_id:team[index%2].id,due_at:extra[index].toISOString(),duration_minutes:index%5===3?30:0});
  await api('/deals/'+deals[0].id+'/notes','POST',{body:'Демо-заметка: обсудили задачи и согласовали следующий шаг.'});
  const pinnedNote=await api('/deals/'+deals[16].id+'/notes','POST',{body:'Перед встречей отправить клиенту обновлённое коммерческое предложение и согласовать участников.'});
  await api('/deals/'+deals[16].id+'/notes/'+pinnedNote.id,'PATCH',{pinned:true});
  await api('/deals/'+deals[16].id+'/communications','POST',{kind:'call',direction:'outgoing',body:'Демо-звонок: обсудили задачу и договорились о следующем шаге.'});
  await api('/deals/'+deals[16].id+'/communications','POST',{kind:'email',direction:'incoming',subject:'Материалы для встречи',body:'Демо-письмо: клиент прислал вопросы перед встречей.'});
  await api('/entity-notes/company/'+companies[1].id,'POST',{body:'Демо-заметка: компания заинтересована в пилоте.'});
  await api('/inbox','POST',{pipeline_id:pipeline.id,title:'Новый запрос на консультацию',contact_name:'Тестовый лид',company_name:'Демо компания',email:'lead@demo.example',source:'Форма сайта',message:'Хотим обсудить пилот.'});
  const upload=await fetch(base+'/api/attachments/deal/'+deals[0].id,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/octet-stream','x-file-name':encodeURIComponent('demo-brief.txt'),'x-file-type':'text/plain'},body:Buffer.from('OpenCRM demo file. No real customer data.\n')});
  if(!upload.ok)throw new Error(`Демо-файл: ${upload.status}`);
  return admin;
}

try{await seed()}catch(error){upstream.closeAllConnections();upstream.close();db.close();rmSync(folder,{recursive:true,force:true});console.error(error);process.exit(1)}

const demo=createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?Buffer.concat(chunks):undefined;
    const headers={'Content-Type':req.headers['content-type']||'application/json',Cookie:cookie};
    for(const key of ['x-file-name','x-file-type','range'])if(req.headers[key])headers[key]=req.headers[key];
    const response=await fetch(base+req.url,{method:req.method,headers,body,duplex:body?'half':undefined});
    res.statusCode=response.status;
    for(const key of ['content-type','cache-control','content-disposition','content-range']){const value=response.headers.get(key);if(value)res.setHeader(key,value)}
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.statusCode=502;res.end('Ошибка демонстрационного сервера')}
});

const port=Number(process.env.DEMO_PORT)||3002;
demo.listen(port,'127.0.0.1',()=>console.log(`OpenCRM демо: http://127.0.0.1:${port} (только вымышленные данные)`));
const shutdown=()=>{demo.closeAllConnections();demo.close();upstream.closeAllConnections();upstream.close();db.close();rmSync(folder,{recursive:true,force:true});process.exit(0)};
process.once('SIGINT',shutdown);
process.once('SIGTERM',shutdown);
