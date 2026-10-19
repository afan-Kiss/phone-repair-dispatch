'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawn}=require('node:child_process');
test('入库、审核、派单、转派、完成幂等、冲销和权限隔离',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repair-test-')),port=33000+Math.floor(Math.random()*10000),base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,PORT:String(port),ADMIN_PASSWORD:'IntegrationTestPassword123!',SUPERADMIN_PASSWORD:'SuperIntegrationTestPassword123!'},stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited}fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 for(let i=0;i<80;i++){try{const r=await fetch(base+'/api/health');if(r.ok)break}catch{}await new Promise(r=>setTimeout(r,50));}
 assert.equal((await fetch(base+'/repair-api/health')).status,200);
 for(const file of ['/shouji','/shifu','/chaojishouji','/repair-assets/app.js','/repair-assets/technician.js','/repair-assets/style.css']){const r=await fetch(base+file);assert.equal(r.status,200,file);assert.ok((await r.text()).length>100);}
 async function api(route,method='GET',data,token){const r=await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});return {status:r.status,...await r.json()}}
 let admin=(await api('/login','POST',{username:'admin',password:'IntegrationTestPassword123!'})).token;assert.ok(admin);
 const superLogin=await api('/login','POST',{username:'superadmin',password:'SuperIntegrationTestPassword123!'});assert.equal(superLogin.user.role,'superadmin');let superToken=superLogin.token;
 assert.equal((await api('/me','PATCH',{display_name:'超级店长',username:'superadmin'},superToken)).user.display_name,'超级店长');
 assert.equal((await api('/me','PATCH',{display_name:'超级店长',username:'超级管理',current_password:'wrong'},superToken)).status,403);
 assert.equal((await api('/me','PATCH',{display_name:'超级店长',username:'超级管理',current_password:'SuperIntegrationTestPassword123!'},superToken)).user.username,'超级管理');
 assert.equal((await api('/login','POST',{username:'superadmin',password:'SuperIntegrationTestPassword123!'})).status,401);
 const renewedSuper=await api('/login','POST',{username:'超级管理',password:'SuperIntegrationTestPassword123!'});assert.equal(renewedSuper.user.display_name,'超级店长');superToken=renewedSuper.token;
 assert.equal((await api('/me','PATCH',{display_name:'普通店长',username:'admin'},admin)).user.display_name,'普通店长');
 assert.equal((await api('/me','PATCH',{display_name:'普通店长',username:'超级管理',current_password:'IntegrationTestPassword123!'},admin)).status,409);
 assert.equal((await api('/me','PATCH',{display_name:'普通店长',username:'前台主管',current_password:'IntegrationTestPassword123!'},admin)).user.username,'前台主管');
 const renewedAdmin=await api('/login','POST',{username:'前台主管',password:'IntegrationTestPassword123!'});assert.equal(renewedAdmin.user.role,'admin');admin=renewedAdmin.token;
 assert.equal((await api('/users','POST',{username:'short_bad',password:'1234',role:'frontdesk'},admin)).status,400);
 assert.equal((await api('/users','POST',{username:'short_ok',password:'12345',role:'frontdesk'},admin)).status,201);
 assert.equal((await api('/login','POST',{username:'short_ok',password:'12345'})).user.role,'frontdesk');
 assert.equal((await api('/register','POST',{username:'tech_short_bad',password:'1234'})).status,400);
 assert.equal((await api('/register','POST',{username:'tech_short_ok',password:'12345'})).status,201);
 assert.equal((await api('/users','POST',{username:'new_admin',password:'NewAdminPassword123!',role:'admin'},admin)).status,403);
 const newAdmin=await api('/users','POST',{username:'new_admin',display_name:'新管理员',password:'NewAdminPassword123!',role:'admin'},superToken);assert.equal(newAdmin.status,201);assert.equal((await api('/users','GET',null,superToken)).users.find(u=>u.id===newAdmin.id).display_name,'新管理员');
 assert.equal((await api('/login','POST',{username:'new_admin',password:'NewAdminPassword123!'})).user.role,'admin');
 assert.equal((await api(`/users/${newAdmin.id}`,'PATCH',{active:false},admin)).status,403);
 assert.equal((await api(`/users/${newAdmin.id}`,'PATCH',{active:false},superToken)).status,200);
 const a=await api('/register','POST',{username:'tech_a',password:'TechnicianPasswordA123!'});assert.equal(a.status,201);
 await api('/register','POST',{username:'tech_b',password:'TechnicianPasswordB123!'});
 const users=(await api('/users','GET',null,admin)).users,techA=users.find(u=>u.username==='tech_a'),techB=users.find(u=>u.username==='tech_b');
 assert.equal((await api('/login','POST',{username:'tech_a',password:'TechnicianPasswordA123!'})).status,403);
 await api('/vip-levels','POST',{name:'VIP3'},admin);
 await api(`/users/${techA.id}`,'PATCH',{approved:true,vip_level:'VIP3'},admin);await api(`/users/${techB.id}`,'PATCH',{approved:true},admin);
 const tokenA=(await api('/login','POST',{username:'tech_a',password:'TechnicianPasswordA123!'})).token,tokenB=(await api('/login','POST',{username:'tech_b',password:'TechnicianPasswordB123!'})).token;
 assert.equal((await api('/me','PATCH',{display_name:'师傅',username:'tech_a'},tokenA)).status,403);
 assert.equal((await api('/finance','GET',null,tokenA)).status,403);
 const created=await api('/orders','POST',{serial:'SERIAL123456',model:'TestPhone',customer:'TestCustomer',plan:'屏幕',charge:'300.00',wage:'100.00',technician_id:techA.id},admin);assert.equal(created.status,201);const orderId=created.order.id,itemId=created.order.items[0].id;assert.equal(created.order.serial_last6,'123456');
 assert.equal((await api('/orders/lookup?serial=SERIAL123456','GET',null,admin)).match.model,'TestPhone');
 assert.equal((await api(`/orders/${orderId}`,'GET',null,tokenB)).status,403);
 await api(`/items/${itemId}/assign`,'POST',{technician_id:techB.id,reason:'原师傅请假'},admin);
 assert.equal((await api(`/items/${itemId}/complete`,'POST',{},tokenA)).status,403);
 assert.equal((await api(`/items/${itemId}/complete`,'POST',{},tokenB)).already_completed,false);
 assert.equal((await api(`/items/${itemId}/complete`,'POST',{},tokenB)).already_completed,true);
 assert.equal((await api(`/items/${itemId}/price`,'PATCH',{charge:'999',wage:'999'},admin)).status,409);
 let finance=await api('/finance','GET',null,admin);assert.equal(finance.charge_cents,30000);assert.equal(finance.wage_cents,10000);assert.equal(finance.entries.length,2);
 const added=await api(`/orders/${orderId}/items`,'POST',{plan:'电池',charge:'100.00',wage:'30.00',technician_id:techA.id},admin);assert.equal(added.status,201);
 const closed=await api(`/orders/${orderId}/return`,'POST',{},admin);assert.equal(closed.order.status,'returned');assert.equal((await api(`/items/${added.item_id}/complete`,'POST',{},tokenA)).status,409);
 finance=await api('/finance','GET',null,admin);assert.equal(finance.charge_cents,0);assert.equal(finance.wage_cents,0);assert.equal(finance.entries.length,4);
 assert.equal((await api(`/orders/${orderId}/return`,'POST',{},admin)).status,409);
 const settled=await api('/orders','POST',{serial:'SERIAL654321',model:'TestPhone2',customer:'TestCustomer2',plan:'主板',charge:'200.00',wage:'35.00',technician_id:techA.id},admin);assert.equal(settled.status,201);
 const settledItem=settled.order.items[0].id;assert.equal((await api(`/items/${settledItem}/complete`,'POST',{},tokenA)).already_completed,false);
 const reassigned=await api(`/items/${settledItem}/assign`,'POST',{technician_id:techB.id,reason:'原师傅返修次数过多'},admin);assert.equal(reassigned.status,200);assert.ok(reassigned.order.items.some(i=>i.status==='pending'&&i.technician_id===techB.id));
 finance=await api('/finance','GET',null,admin);assert.ok(finance.entries.some(e=>e.kind==='wage_reversal'&&e.amount_cents===-3500));
 assert.equal(finance.deduction_cents,0,'转派只能扣回一次工价');
 assert.equal((await api(`/items/${settledItem}/assign`,'POST',{technician_id:techB.id,reason:'重复转派'},admin)).status,409);
 assert.equal((await api(`/items/${settledItem}/complete`,'POST',{},tokenA)).status,403);
 assert.equal((await api(`/orders/${settled.order.id}`,'GET',null,tokenA)).status,403);
 const replacement=reassigned.order.items.find(i=>i.status==='pending'&&i.technician_id===techB.id);
 assert.equal((await api(`/items/${replacement.id}/assign`,'POST',{technician_id:techB.id,reason:'原地转派'},admin)).status,400);
 const own=await api(`/items/${replacement.id}/complete`,'POST',{},tokenB);
 assert.equal(own.order.items.length,1);
 assert.equal('charge_cents' in own.order.items[0],false,'师傅完成接口不泄露客户金额');
 finance=await api('/finance','GET',null,admin);
 assert.equal(finance.charge_cents,20000,'售后不增加客户收费');
 assert.equal(finance.wage_cents,3500,'同项目仅新师傅取得工价');
 assert.equal((await api(`/orders/${settled.order.id}/return`,'POST',{},admin)).status,200,'转派后仍能退机');
 finance=await api('/finance','GET',null,admin);assert.equal(finance.wage_cents,0);assert.equal(finance.charge_cents,0);
 assert.equal((await api('/orders/lookup?serial=654321','GET',null,admin)).match,null,'后六位不得自动取第一台设备');
 const malformed=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'null'});assert.equal(malformed.status,400);
 
 
 const liabilityOrder=await api('/orders','POST',{serial:'DEBT123456',model:'测试机',customer:'测试客户',plan:'电池',charge:'0',wage:'35',technician_id:techA.id},admin);
 await api('/items/'+liabilityOrder.order.items[0].id+'/complete','POST',{},tokenA);
 assert.equal((await api('/deductions','POST',{responsible_technician_id:techA.id,amount:'20',reason:'屏幕损坏',kind:'额外维修'},admin)).status,201);
 assert.equal((await api('/stats','GET',null,tokenA)).total.wage_cents,1500);
 await api('/items/'+liabilityOrder.order.items[0].id+'/assign','POST',{technician_id:techB.id,reason:'无法完成售后'},admin);
 assert.equal((await api('/stats','GET',null,tokenA)).total.pending_deduction_cents,2000,'工资冲销后仍显示后续需抵扣金额');
 const future=await api('/orders','POST',{serial:'NEXT123456',model:'测试机',customer:'测试客户',plan:'新维修',charge:'95',wage:'35',technician_id:techA.id},admin);
 await api('/items/'+future.order.items[0].id+'/complete','POST',{},tokenA);
 const futureStats=await api('/stats','GET',null,tokenA);
 assert.equal(futureStats.total.wage_cents,1500);assert.equal(futureStats.total.pending_deduction_cents,0,'以后工价继续抵扣');
 const auditEntries=(await api('/audit','GET',null,admin)).entries;
 assert.ok(auditEntries.length>=5);
 const deductionAudit=auditEntries.find(e=>e.entity==='deduction');
 assert.match(deductionAudit.message,/登记了责任扣款/);
 assert.match(deductionAudit.message,/扣款 20\.00 元/);
 assert.match(deductionAudit.message,/屏幕损坏/);
 async function session(route,method,data,token,client){const r=await fetch(base+'/repair-api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(client?{'X-Repair-Client':client}:{})},body:data?JSON.stringify(data):undefined});return {status:r.status,...await r.json()}}
 for(const [username,password,client] of [['tech_a','TechnicianPasswordA123!','admin'],['前台主管','IntegrationTestPassword123!','technician'],['前台主管','IntegrationTestPassword123!','superadmin'],['超级管理','SuperIntegrationTestPassword123!','admin']]){
   assert.equal((await session('/login','POST',{username,password,client},null,client)).status,403);
 }
 const web=await session('/login','POST',{username:'tech_a',password:'TechnicianPasswordA123!',client:'technician'},null,'technician');
 assert.equal(web.status,200);
 assert.equal((await api('/me','GET',null,tokenA)).status,401,'旧令牌失效');
 for(const client of ['admin','superadmin','miniprogram',undefined])assert.equal((await session('/me','GET',null,web.token,client)).status,401,'令牌来源隔离');
 assert.equal((await session('/me','GET',null,web.token,'technician')).status,200);
 const mini=await session('/login','POST',{username:'tech_a',password:'TechnicianPasswordA123!',client:'miniprogram'},null,'miniprogram');
 assert.equal(mini.status,200);
 assert.equal((await session('/me','GET',null,web.token,'technician')).status,401,'小程序登录挤下网页端');
 assert.equal((await session('/me','GET',null,mini.token,'miniprogram')).status,200);
 assert.equal((await session('/logout','POST',{},mini.token,'miniprogram')).status,200);
 assert.equal((await session('/me','GET',null,mini.token,'miniprogram')).status,401,'退出后令牌失效');
 for(const client of ['admin','superadmin']){
   const account=client==='admin'?{username:'前台主管',password:'IntegrationTestPassword123!'}:{username:'超级管理',password:'SuperIntegrationTestPassword123!'};
   const r=await session('/login','POST',{...account,client},null,client);
   assert.equal(r.status,200);assert.equal((await session('/me','GET',null,r.token,client)).status,200);
   assert.equal((await session('/me','GET',null,r.token,client==='admin'?'superadmin':'admin')).status,401);
 }

});
