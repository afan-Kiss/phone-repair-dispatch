'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');

async function system(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repair-money-'));
  let child, port, logs='', requests=0;
  async function stop(){if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done}}
  async function start(){
    child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,PORT:'0',ADMIN_PASSWORD:'MoneyTestPassword123!',SUPERADMIN_PASSWORD:'SuperTestPassword123!'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',b=>{logs+=b;const match=String(b).match(/127\.0\.0\.1:(\d+)/);if(match)port=Number(match[1])});
    child.stderr.on('data',b=>{logs+=b});
    for(let n=0;n<150&&!port;n++) {if(child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,20))}
    assert.ok(port,'服务启动失败：'+logs);
  }
  t.after(async()=>{await stop();fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
  await start();
  async function api(route,method='GET',data,token,key){
    requests++;
    const r=await fetch(`http://127.0.0.1:${port}/repair-api${route}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{})},body:data===undefined?undefined:JSON.stringify(data)});
    const result=await r.json();return {status:r.status,...result};
  }
  async function ok(route,method,data,token,key){const r=await api(route,method,data,token,key);assert.ok(r.status>=200&&r.status<300,`${method} ${route}: ${JSON.stringify(r)}`);return r}
  const admin=(await ok('/login','POST',{username:'admin',password:'MoneyTestPassword123!'})).token;
  const teachers=[];
  for(let i=0;i<3;i++){
    const u=await ok('/users','POST',{username:'worker'+i,password:'WorkerPassword123!',role:'technician'},admin);
    const token=(await ok('/login','POST',{username:'worker'+i,password:'WorkerPassword123!'})).token;
    teachers.push({id:u.id,token});
  }
  const order=(tech=teachers[0],extra={})=>({serial:'DEVICE123456',model:'测试机',customer:'模拟客户',plan:'自定义维修',charge:'85.50',wage:'35.00',technician_id:tech.id,...extra});
  return {api,ok,admin,teachers,order,dir,get port(){return port},get requests(){return requests},async restart(){await stop();port=null;await start()},inspect(fn){const db=new DatabaseSync(path.join(dir,'repair.sqlite'));try{return fn(db)}finally{db.close()}},logs:()=>logs};
}
const sum=(rows,kind)=>rows.filter(e=>kind(e)).reduce((n,e)=>n+e.amount_cents,0);
const amount=c=>(c/100).toFixed(2);
function random(seed){return ()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296}}

for(const seed of [71019,35195,20261019]) test(`金额模型随机流程 seed=${seed}，80 单及多次转派、冲销`,async t=>{
  const s=await system(t), rng=random(seed), choose=n=>Math.floor(rng()*n);
  const expected={charge:0,wages:new Map(s.teachers.map(u=>[u.id,0])),deductions:new Map(s.teachers.map(u=>[u.id,0]))};
  let completions=0,transfers=0,closures=0,items=0;
  async function check(){
    const f=await s.ok('/finance','GET',undefined,s.admin);
    assert.equal(f.charge_cents,expected.charge,'客户收费');
    assert.equal(f.wage_cents,[...expected.wages.values()].reduce((a,b)=>a+b,0),'全体师傅工价');
    assert.equal(f.deduction_cents,[...expected.deductions.values()].reduce((a,b)=>a+b,0),'责任扣款');
    for(const worker of s.teachers){
      const stats=await s.ok('/stats','GET',undefined,worker.token),gross=expected.wages.get(worker.id),debt=expected.deductions.get(worker.id);
      assert.equal(stats.total.gross_wage_cents,gross,'师傅毛工价');
      assert.equal(stats.total.wage_cents,Math.max(0,gross-debt),'师傅实际可结算');
      assert.equal(stats.total.pending_deduction_cents,Math.max(0,debt-gross),'未抵扣金额');
      const filtered=await s.ok('/finance?technician_id='+worker.id,'GET',undefined,s.admin);
      assert.equal(filtered.wage_cents,gross,'财务按师傅筛选');
    }
    s.inspect(db=>{
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM (SELECT item_id,kind,COUNT(*) n FROM ledger GROUP BY item_id,kind HAVING COUNT(*)>1)').get().n,0);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger l JOIN items i ON i.id=l.item_id WHERE l.kind='wage' AND (l.amount_cents<>i.wage_snapshot_cents OR l.technician_id<>i.completed_by)").get().n,0,'工价严格取完成快照');
    });
  }
  for(let n=0;n<80;n++){
    let worker=s.teachers[choose(3)];
    const originalCharge=choose(200001),initialWage=choose(15001);
    const created=await s.ok('/orders','POST',s.order(worker,{serial:'SIM'+seed+'-'+n+'123456',charge:amount(originalCharge),wage:amount(initialWage)}),s.admin);
    const orderId=created.order.id,chain=[];
    const count=1+choose(3);
    for(let j=0;j<count;j++){
      let item;
      if(j===0)item=created.order.items[0];
      else {worker=s.teachers[choose(3)];const added=await s.ok(`/orders/${orderId}/items`,'POST',{plan:'自定义项目'+j,charge:amount(choose(100001)),wage:amount(choose(15001)),technician_id:worker.id},s.admin);item=added.order.items.find(i=>i.id===added.item_id)}
      items++;
      if(choose(2)){
        const charge=choose(200001),wage=choose(15001);
        const changed=await s.ok(`/items/${item.id}/price`,'PATCH',{charge:amount(charge),wage:amount(wage)},s.admin);
        item=changed.order.items.find(i=>i.id===item.id);
      }
      if(choose(2)){
        const other=s.teachers.find(u=>u.id!==item.technician_id);
        const moved=await s.ok(`/items/${item.id}/assign`,'POST',{technician_id:other.id,reason:'请假改派'},s.admin);
        item=moved.order.items.find(i=>i.id===item.id);transfers++;
      }
      const rounds=choose(4);
      for(let round=0;round<=rounds;round++){
        if(round===rounds&&choose(4)===0){chain.push(item);break}
        const owner=s.teachers.find(u=>u.id===item.technician_id);
        const replies=await Promise.all(Array.from({length:4},()=>s.api(`/items/${item.id}/complete`,'POST',{wage:'99999999',technician_id:999},owner.token)));
        assert.equal(replies.filter(r=>r.already_completed===false).length,1,'并发完成只成功入账一次');
        assert.ok(replies.every(r=>r.status===200));completions++;
        expected.charge+=item.charge_cents;expected.wages.set(owner.id,expected.wages.get(owner.id)+item.wage_cents);
        item={...item,status:'completed'};chain.push(item);
        assert.equal((await s.api(`/items/${item.id}/price`,'PATCH',{charge:'0',wage:'999999'},s.admin)).status,409);
        if(round===rounds)break;
        const other=s.teachers[(s.teachers.indexOf(owner)+1)%3];
        const moved=await s.ok(`/items/${item.id}/assign`,'POST',{technician_id:other.id,reason:'返修改派'},s.admin);transfers++;
        expected.wages.set(owner.id,expected.wages.get(owner.id)-item.wage_cents);
        chain[chain.length-1].superseded=true;
        assert.equal((await s.api(`/items/${item.id}/complete`,'POST',{},owner.token)).status,403);
        item=moved.order.items.find(i=>i.id===moved.order.items.find(old=>old.id===item.id).superseded_by);
        assert.ok(item);assert.equal(item.charge_cents,0);items++;
      }
    }
    if(choose(2)){
      const owner=s.teachers[choose(3)],cents=1+choose(300001);
      await s.ok('/deductions','POST',{responsible_technician_id:owner.id,amount:amount(cents),order_id:orderId,kind:'损坏买断',reason:'模拟责任损失'},s.admin);
      expected.deductions.set(owner.id,expected.deductions.get(owner.id)+cents);
    }
    if(choose(3)!==0){
      const close=choose(2)?'return':'cancel';
      const replies=await Promise.all(Array.from({length:3},()=>s.api(`/orders/${orderId}/${close}`,'POST',{},s.admin)));
      assert.equal(replies.filter(r=>r.status===200).length,1);assert.ok(replies.every(r=>[200,409].includes(r.status)));closures++;
      for(const i of chain)if(i.status==='completed'){
        expected.charge-=i.charge_cents;
        if(!i.superseded)expected.wages.set(i.technician_id,expected.wages.get(i.technician_id)-i.wage_cents);
      }
      assert.equal((await s.api(`/orders/${orderId}/items`,'POST',{plan:'违规追加',charge:'95',wage:'35',technician_id:worker.id},s.admin)).status,409);
    }
    if(n%10===0)await check();
  }
  await check();
  const before=await s.ok('/finance','GET',undefined,s.admin);await s.restart();
  const after=await s.ok('/finance','GET',undefined,s.admin);assert.deepEqual(after,before,'重启后金额和流水不变');
  await check();
  t.diagnostic(JSON.stringify({seed,orders:80,items,completions,transfers,closures,requests:s.requests}));
});

test('责任扣款与今日、本月、累计工资对账',async t=>{
  const s=await system(t),u=s.teachers[0];
  const made=await s.ok('/orders','POST',s.order(),s.admin);
  await s.ok(`/items/${made.order.items[0].id}/complete`,'POST',{},u.token);
  await s.ok('/deductions','POST',{responsible_technician_id:u.id,amount:'20',reason:'额外维修'},s.admin);
  const stats=await s.ok('/stats','GET',undefined,u.token);
  for(const period of ['today','month','total'])assert.equal(stats[period].wage_cents,1500,period+'扣款后的工价');
});

test('跨月工价冲销后，扣款恢复待扣并从以后工资继续抵扣',async t=>{
  const s=await system(t),u=s.teachers[0];
  const old=await s.ok('/orders','POST',s.order(),s.admin);
  await s.ok(`/items/${old.order.items[0].id}/complete`,'POST',{},u.token);
  await s.ok('/deductions','POST',{responsible_technician_id:u.id,amount:'20',reason:'损坏责任'},s.admin);
  s.inspect(db=>{db.exec("UPDATE ledger SET created_at='2020-01-01T00:00:00.000Z'; UPDATE deductions SET created_at='2020-01-01T00:00:00.000Z'; UPDATE deduction_payments SET created_at='2020-01-01T00:00:00.000Z'");});
  await s.ok(`/orders/${old.order.id}/return`,'POST',{},s.admin);
  let listed=await s.ok('/deductions','GET',undefined,s.admin);
  assert.equal(listed.deductions[0].pending_cents,2000,'冲销后责任款恢复待扣');
  const next=await s.ok('/orders','POST',s.order(u,{wage:'10'}),s.admin);
  await s.ok(`/items/${next.order.items[0].id}/complete`,'POST',{},u.token);
  listed=await s.ok('/deductions','GET',undefined,s.admin);
  assert.equal(listed.deductions[0].paid_cents,1000);assert.equal(listed.deductions[0].pending_cents,1000);
  const stats=await s.ok('/stats','GET',undefined,u.token);
  for(const period of ['today','month','total']){assert.equal(stats[period].wage_cents,0);assert.equal(stats[period].pending_deduction_cents,1000);}
});

test('相同请求编号重试扣款、入库和追加，不重复记账',async t=>{
  const s=await system(t),u=s.teachers[0];
  const d={responsible_technician_id:u.id,amount:'20',reason:'网络重试测试'};
  const replies=await Promise.all(Array.from({length:20},()=>s.api('/deductions','POST',d,s.admin,'same-deduction')));
  assert.ok(replies.every(r=>r.status===201));assert.equal(new Set(replies.map(r=>r.deduction_id)).size,1);
  assert.equal((await s.ok('/finance','GET',undefined,s.admin)).deduction_cents,2000);
  assert.equal((await s.api('/deductions','POST',{...d,amount:'999'},s.admin,'same-deduction')).status,409,'相同请求编号不得换金额');
  const orders=await Promise.all(Array.from({length:12},()=>s.api('/orders','POST',s.order(),s.admin,'same-order')));
  assert.equal(new Set(orders.map(r=>r.order.id)).size,1);
  const id=orders[0].order.id,body={plan:'电池',charge:'0',wage:'12.34',technician_id:u.id};
  const adds=await Promise.all(Array.from({length:12},()=>s.api(`/orders/${id}/items`,'POST',body,s.admin,'same-item')));
  assert.equal(new Set(adds.map(r=>r.item_id)).size,1);
  await s.restart();
  assert.equal((await s.ok('/deductions','POST',d,s.admin,'same-deduction')).deduction_id,replies[0].deduction_id,'重启不丢失防重记录');
});

test('非法金额、串改金额、越权请求全部不入账',async t=>{
  const s=await system(t),u=s.teachers[0];
  const before=await s.ok('/finance','GET',undefined,s.admin);
  for(const invalid of ['-1','0.001','1e6','NaN','Infinity','9007199254740992',null,[],{},true,['35']]){
    assert.equal((await s.api('/orders','POST',s.order(u,{wage:invalid}),s.admin)).status,400,'金额必须为有效数值：'+JSON.stringify(invalid));
  }
  for(const route of ['/orders','/deductions','/users','/vip-levels'])assert.equal((await s.api(route,'POST',s.order(),u.token)).status,403);
  assert.equal((await s.api('/finance','GET',undefined,u.token)).status,403);
  assert.equal((await s.api('/orders','POST',s.order(),'forged-token')).status,401);
  const valid=await s.ok('/orders','POST',s.order(u),s.admin),item=valid.order.items[0];
  assert.equal((await s.api(`/items/${item.id}/complete`,'POST',{},s.teachers[1].token)).status,403);
  assert.equal((await s.api(`/items/${item.id}/complete`,'POST',{},s.admin)).status,403);
  assert.deepEqual(await s.ok('/finance','GET',undefined,s.admin),before);
  await s.ok(`/items/${item.id}/complete`,'POST',{wage:'999999999',wage_cents:999999999,charge:'99999999',role:'admin'},u.token);
  const f=await s.ok('/finance','GET',undefined,s.admin);assert.equal(f.wage_cents,3500);assert.equal(f.charge_cents,8550);
});

test('审计写入失败时，改价必须整体回滚',async t=>{
  const s=await system(t),made=await s.ok('/orders','POST',s.order(),s.admin),item=made.order.items[0];
  s.inspect(db=>db.exec("CREATE TRIGGER fail_price_audit BEFORE INSERT ON audit WHEN NEW.action='price_changed' BEGIN SELECT RAISE(ABORT,'模拟磁盘写入失败'); END"));
  assert.equal((await s.api(`/items/${item.id}/price`,'PATCH',{charge:'1',wage:'9999'},s.admin)).status,500);
  const after=(await s.ok('/orders/'+made.order.id,'GET',undefined,s.admin)).order.items[0];
  assert.equal(after.wage_cents,3500);assert.equal(after.charge_cents,8550);
});

test('完成时流水写入失败全部回滚，恢复后可以准确结算一次',async t=>{
  const s=await system(t),u=s.teachers[0];
  const made=await s.ok('/orders','POST',s.order(u,{wage:'0.29',charge:'95.01'}),s.admin),id=made.order.items[0].id;
  s.inspect(db=>db.exec("CREATE TRIGGER fail_wage BEFORE INSERT ON ledger WHEN NEW.kind='wage' BEGIN SELECT RAISE(ABORT,'模拟流水写入失败'); END"));
  assert.equal((await s.api(`/items/${id}/complete`,'POST',{},u.token)).status,500);
  s.inspect(db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger').get().n,0);assert.equal(db.prepare('SELECT status FROM items WHERE id=?').get(id).status,'pending');db.exec('DROP TRIGGER fail_wage');});
  await s.ok(`/items/${id}/complete`,'POST',{},u.token);
  const finance=await s.ok('/finance','GET',undefined,s.admin);
  assert.equal(finance.wage_cents,29);assert.equal(finance.charge_cents,9501);
});

test('传输请求期间账号停用，未结束的旧请求也必须失效',async t=>{
  const s=await system(t);
  const desk=await s.ok('/users','POST',{username:'desk',password:'DeskTestPassword123!',role:'frontdesk'},s.admin);
  const token=(await s.ok('/login','POST',{username:'desk',password:'DeskTestPassword123!'})).token;
  const payload=JSON.stringify(s.order());
  let req;
  const result=new Promise((resolve,reject)=>{
    req=http.request({host:'127.0.0.1',port:s.port,path:'/repair-api/orders',method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,body:raw}))});req.on('error',reject);req.write(payload.slice(0,1));
  });
  await s.ok('/me','GET',undefined,token);
  await s.ok('/users/'+desk.id,'PATCH',{active:false},s.admin);
  req.end(payload.slice(1));
  assert.equal((await result).status,401);
  assert.equal((await s.ok('/orders','GET',undefined,s.admin)).orders.length,0);
});

test('同尾号、同全码、多客户和售后客户更新保留正确关联',async t=>{
  const s=await system(t);
  const records=[];
  for(const [serial,customer] of [['FIRST123456','客户甲'],['SECOND123456','客户乙'],['FIRST123456','客户丙']])records.push((await s.ok('/orders','POST',s.order(s.teachers[records.length],{serial,customer}),s.admin)).order);
  const lookup=await s.ok('/orders/lookup?serial=123456','GET',undefined,s.admin);
  assert.equal(lookup.match,null);assert.equal(lookup.matches.length,3);
  assert.equal((await s.ok('/orders/lookup?serial=FIRST123456','GET',undefined,s.admin)).matches.length,2);
  await s.ok('/orders/'+records[0].id,'PATCH',{customer:'新贸易客户'},s.admin);
  assert.equal((await s.ok('/orders/'+records[0].id,'GET',undefined,s.teachers[0].token)).order.customer,'新贸易客户');
  assert.equal((await s.ok('/orders/'+records[2].id,'GET',undefined,s.admin)).order.customer,'客户丙');
  const audit=await s.ok('/audit','GET',undefined,s.admin);
  assert.ok(audit.entries.some(e=>e.action==='customer_updated'&&JSON.parse(e.details).old_customer==='客户甲'));
});
