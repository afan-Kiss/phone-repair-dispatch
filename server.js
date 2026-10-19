'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const loginFailures = new Map();
const authAttempts = new Map();
function limitAuth(req, route) {
  const current=Date.now();
  for(const [key,value] of authAttempts) if(current-value.start>=15*60*1000) authAttempts.delete(key);
  const key=`${req.socket.remoteAddress}|${route}`, row=authAttempts.get(key)||{start:current,count:0};
  if(row.count >= (route==='/register'?20:120)) bad(429,'操作过于频繁，请稍后重试');
  row.count++; authAttempts.set(key,row);
}
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 10;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'repair.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '', pass_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','frontdesk','technician')), vip_level TEXT NOT NULL DEFAULT '普通', approved INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, client TEXT NOT NULL DEFAULT 'unknown');
CREATE TABLE IF NOT EXISTS models(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS vip_levels(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, discount_tenths INTEGER NOT NULL CHECK(discount_tenths BETWEEN 10 AND 100), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, serial TEXT NOT NULL, serial_last6 TEXT NOT NULL, model TEXT NOT NULL, customer TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','returned','cancelled')), created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_serial ON orders(serial);
CREATE INDEX IF NOT EXISTS idx_orders_last6 ON orders(serial_last6);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), plan TEXT NOT NULL, charge_cents INTEGER NOT NULL CHECK(charge_cents>=0), wage_cents INTEGER NOT NULL CHECK(wage_cents>=0), technician_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','returned','cancelled')), completed_at TEXT, charge_snapshot_cents INTEGER, wage_snapshot_cents INTEGER, completed_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_items_technician ON items(technician_id,status);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), kind TEXT NOT NULL CHECK(kind IN ('charge','wage','charge_reversal','wage_reversal')), amount_cents INTEGER NOT NULL, technician_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL, UNIQUE(item_id,kind));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id), entity TEXT NOT NULL, entity_id INTEGER, action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assignment_history(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), from_technician_id INTEGER REFERENCES users(id), to_technician_id INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL, old_wage_cents INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deductions(id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), item_id INTEGER REFERENCES items(id), responsible_technician_id INTEGER NOT NULL REFERENCES users(id), beneficiary_technician_id INTEGER REFERENCES users(id), kind TEXT NOT NULL, reason TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deduction_payments(id INTEGER PRIMARY KEY, deduction_id INTEGER NOT NULL REFERENCES deductions(id), technician_id INTEGER NOT NULL REFERENCES users(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0), created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_deductions_tech ON deductions(responsible_technician_id);
`);
if (!db.prepare("PRAGMA table_info(users)").all().some(column => column.name === 'is_superadmin')) db.exec('ALTER TABLE users ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("PRAGMA table_info(users)").all().some(column => column.name === 'display_name')) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
if (!db.prepare("PRAGMA table_info(users)").all().some(column => column.name === 'deleted_at')) db.exec("ALTER TABLE users ADD COLUMN deleted_at TEXT");
if (!db.prepare("PRAGMA table_info(sessions)").all().some(column => column.name === 'client')) db.exec("ALTER TABLE sessions ADD COLUMN client TEXT NOT NULL DEFAULT 'unknown'");

if (!db.prepare("PRAGMA table_info(items)").all().some(column => column.name === 'superseded_by')) db.exec('ALTER TABLE items ADD COLUMN superseded_by INTEGER REFERENCES items(id)');

const now = () => new Date().toISOString();
const localDay = () => { const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value])); return `${parts.year}-${parts.month}-${parts.day}`; };
const bad = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const required = (value, label) => { const s = String(value ?? '').trim(); if (!s) bad(400, `${label}不能为空`); return s; };
const money = (value, label) => { if(!['string','number'].includes(typeof value)) bad(400,`${label}必须是金额`); const s=String(value); if(!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(s)) bad(400,`${label}必须是非负金额，最多两位小数`); const [whole,fraction='']=s.split('.'); const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')); if(cents>BigInt(Number.MAX_SAFE_INTEGER)) bad(400,`${label}超出范围`); return Number(cents); };
const hashPassword = password => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; };
const checkPassword = (password, stored) => { const [salt, hash] = stored.split(':'); return !!salt && !!hash && crypto.timingSafeEqual(crypto.scryptSync(password, salt, 64), Buffer.from(hash, 'hex')); };
const audit = (actor, entity, id, action, details = {}) => db.prepare('INSERT INTO audit(actor_id,entity,entity_id,action,details,created_at) VALUES(?,?,?,?,?,?)').run(actor, entity, id, action, JSON.stringify(details), now());
function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
function seed() {
  if (!db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get() && process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 5) throw new Error('ADMIN_PASSWORD 至少需要 5 位');
    db.prepare("INSERT INTO users(username,pass_hash,role,vip_level,approved,created_at) VALUES(?,?,'admin','管理员',1,?)").run(process.env.ADMIN_USERNAME || 'admin', hashPassword(process.env.ADMIN_PASSWORD), now());
  }
  if (!db.prepare('SELECT id FROM users WHERE is_superadmin=1 LIMIT 1').get() && process.env.SUPERADMIN_PASSWORD) {
    if (process.env.SUPERADMIN_PASSWORD.length < 5) throw new Error('SUPERADMIN_PASSWORD 至少需要 5 位');
    db.prepare("INSERT INTO users(username,pass_hash,role,vip_level,approved,created_at,is_superadmin) VALUES(?,?,'admin','超级管理员',1,?,1)").run(process.env.SUPERADMIN_USERNAME || 'superadmin', hashPassword(process.env.SUPERADMIN_PASSWORD), now());
  }
  if (!db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()) throw new Error('首次启动请设置至少 5 位的 ADMIN_PASSWORD 或 SUPERADMIN_PASSWORD');
}
seed();
db.prepare('INSERT OR IGNORE INTO vip_levels(name,discount_tenths,created_at) VALUES(?,100,?)').run('普通',now());
for (const row of db.prepare("SELECT DISTINCT vip_level FROM users WHERE role='technician' AND vip_level<>''").all()) db.prepare('INSERT OR IGNORE INTO vip_levels(name,discount_tenths,created_at) VALUES(?,100,?)').run(row.vip_level,now());

function vipLevel(name) {
  const level=db.prepare('SELECT * FROM vip_levels WHERE name=?').get(required(name,'VIP 等级'));
  if (!level) bad(400,'请选择已配置的 VIP 等级');
  return level;
}
function discountTenths(value) {
  const text=String(value ?? '').trim();
  if (!/^(?:[1-9](?:\.\d)?|10(?:\.0)?)$/.test(text)) bad(400,'折扣须为 1 至 10 折，最多一位小数');
  return Math.round(Number(text)*10);
}
const roleLabel = u => u?.is_superadmin ? '超级管理员' : ({admin:'普通管理员',frontdesk:'前台',technician:'师傅'}[u?.role] || '系统');
function operationMessage(row) {
  const d=(()=>{ try{return JSON.parse(row.details||'{}')}catch{return {}} })();
  const who=`${row.actor_display_name||row.actor_name||'系统'}（${roleLabel(row)}）`;
  const messages={login:'登录了系统',registered:'注册了师傅账号',created:'创建了账号或维修项目',profile_updated:'修改了自己的资料',updated:'修改了账号或等级设置',deleted:'删除了账号',added:'添加了基础资料',reassigned:'重新指派了维修项目',price_changed:'修改了维修项目价格',completed:'完成了维修项目并结算工价',returned:'办理了退机',cancelled:'取消了订单',created_order:'创建了维修订单'};
  let action=messages[row.action]||'进行了系统操作';
  if(row.action==='created' && row.entity==='order') action='创建了维修订单';
  if(row.action==='created' && row.entity==='item') action='添加了维修项目';
  if(row.action==='created' && row.entity==='deduction') action='登记了责任扣款';
  if(row.action==='created' && row.entity==='user') action=d.role==='technician'?'创建了师傅账号':'创建了管理员或前台账号';
  if(row.action==='updated' && row.entity==='user') action='审核或修改了账号';
  if(row.action==='deleted' && row.entity==='user') action='删除了账号';
  if(row.action==='updated' && row.entity==='vip_level') action='修改了等级名称';
  if(row.action==='customer_updated' && row.entity==='order') action='更新了售后客户姓名';
  const extra=[];
  if(row.entity==='order' && row.entity_id) extra.push(`订单 #${row.entity_id}`);
  if(row.entity==='item' && row.entity_id) extra.push(`维修项目 #${row.entity_id}`);
  if(row.action==='customer_updated') extra.push(`原客户“${d.old_customer||''}”，新客户“${d.customer||''}”`);
  if(d.username) extra.push(`登录账号“${d.username}”`);
  if(d.display_name) extra.push(`显示名称“${d.display_name}”`);
  if(d.name && row.entity==='vip_level') extra.push(`等级“${d.name}”`);
  if(d.plan) extra.push(`方案“${d.plan}”`);
  if(d.wage_cents!==undefined) extra.push(`工价 ${Number(d.wage_cents/100).toFixed(2)} 元`);
  if(d.charge_cents!==undefined) extra.push(`客户收费 ${Number(d.charge_cents/100).toFixed(2)} 元`);
  if(row.entity==='deduction') {
    if(d.amount_cents!==undefined) extra.push(`扣款 ${Number(d.amount_cents/100).toFixed(2)} 元`);
    if(d.kind) extra.push(`类型“${d.kind}”`);
    if(d.responsible_technician_id) extra.push(`责任师傅编号 #${d.responsible_technician_id}`);
  }
  if(d.order_id) extra.push(`订单 #${d.order_id}`);
  if(d.reason) extra.push(`原因“${d.reason}”`);
  return `${who}${action}${extra.length?'（'+extra.join('，')+'）':''}`;
}

const sessionClients = new Set(['admin','superadmin','technician','miniprogram','unknown']);
function requestedClient(req) {
  const client = String(req.headers['x-repair-client'] || '').trim().toLowerCase();
  return sessionClients.has(client) ? client : 'unknown';
}
function actor(req) {
  const token = (req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];
  if (!token) bad(401, '请先登录');
  const user = db.prepare('SELECT u.id,u.username,u.display_name,u.role,u.vip_level,u.approved,u.active,u.is_superadmin,s.client AS session_client FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(crypto.createHash('sha256').update(token).digest('hex'), now());
  if (!user || !user.active || !user.approved) bad(401, '登录已失效或账号未审核');
  const client = requestedClient(req);
  if (user.session_client !== client) bad(401, '登录端不匹配，请重新登录');
  if (user.is_superadmin) user.role = 'superadmin';
  return user;
}
function allow(user, ...roles) { if (!roles.includes(user.role) && !(user.role === 'superadmin' && roles.includes('admin'))) bad(403, '无权操作'); }
function cleanUser(u) { return { id:u.id, username:u.username, display_name:u.display_name || u.username, role:u.is_superadmin?'superadmin':u.role, vip_level:u.vip_level, approved:!!u.approved, active:!!u.active }; }
function getOrder(id) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!order) bad(404, '订单不存在');
  order.items = db.prepare("SELECT i.*,COALESCE(NULLIF(u.display_name,''),u.username) AS technician_name,u.vip_level FROM items i JOIN users u ON u.id=i.technician_id WHERE i.order_id=? ORDER BY i.id").all(id);
  order.assignment_history = db.prepare(`SELECT h.*,fu.display_name AS from_technician_name,tu.display_name AS to_technician_name,au.display_name AS operator_name FROM assignment_history h LEFT JOIN users fu ON fu.id=h.from_technician_id JOIN users tu ON tu.id=h.to_technician_id JOIN users au ON au.id=h.created_by WHERE h.item_id IN (SELECT id FROM items WHERE order_id=?) ORDER BY h.id DESC`).all(id);
  order.deductions = db.prepare(`SELECT d.*,u.display_name AS responsible_name,b.display_name AS beneficiary_name,MIN(d.amount_cents,MAX(0,COALESCE((SELECT SUM(l.amount_cents) FROM ledger l WHERE l.technician_id=d.responsible_technician_id AND l.kind IN ('wage','wage_reversal')),0)-COALESCE((SELECT SUM(older.amount_cents) FROM deductions older WHERE older.responsible_technician_id=d.responsible_technician_id AND older.id<d.id),0))) AS paid_cents FROM deductions d JOIN users u ON u.id=d.responsible_technician_id LEFT JOIN users b ON b.id=d.beneficiary_technician_id WHERE d.order_id=? ORDER BY d.id DESC`).all(id).map(d=>({...d,pending_cents:Math.max(0,d.amount_cents-Number(d.paid_cents||0))}));
  return order;
}
function visibleOrder(user, id) {
  const order = getOrder(id);
  if (user.role === 'technician') {
    order.items = order.items.filter(i => i.technician_id === user.id && !i.superseded_by).map(({charge_cents,charge_snapshot_cents,...item})=>item);
    order.assignment_history = order.assignment_history.filter(h=>h.to_technician_id===user.id||h.from_technician_id===user.id);
    order.deductions = order.deductions.filter(d=>d.responsible_technician_id===user.id);
    if (!order.items.length) bad(403, '此订单未分配给你');
  }
  return order;
}
function technician(id) {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND role='technician' AND approved=1 AND active=1").get(Number(id));
  if (!u) bad(400, '请选择已审核的师傅');
  return u;
}
function addItem(orderId, input, actorId) {
  const plan = required(input.plan, '维修方案');
  const t = technician(input.technician_id);
  const charge = money(input.charge, '客户收费');
  const wage = money(input.wage, '工价');
  const id = db.prepare('INSERT INTO items(order_id,plan,charge_cents,wage_cents,technician_id,created_at) VALUES(?,?,?,?,?,?)').run(orderId,plan,charge,wage,t.id,now()).lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO plans(name) VALUES(?)').run(plan);
  audit(actorId,'item',Number(id),'created',{order_id:orderId,plan,charge_cents:charge,wage_cents:wage,technician_id:t.id});
  return Number(id);
}
db.exec(`CREATE TABLE IF NOT EXISTS request_results(user_id INTEGER NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,request_key))`);
function mutation(req,user,input,fn) {
  const key=req.headers['idempotency-key'];
  if(key!==undefined && (typeof key!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(key))) bad(400,'请求编号无效');
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify([req.method,req.url,input])).digest('hex');
  return tx(()=>{
    if(key){const old=db.prepare('SELECT * FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key);if(old){if(old.fingerprint!==fingerprint)bad(409,'该请求编号已用于其他操作');return JSON.parse(old.result);}}
    const result=fn();
    if(key)db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?)').run(user.id,key,fingerprint,JSON.stringify(result),now());
    return result;
  });
}
function settleDeductions(technicianId, at = now()) {
  const gross = Number(db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS total FROM ledger WHERE technician_id=? AND kind IN ('wage','wage_reversal')").get(technicianId).total || 0);
  const paid = Number(db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS total FROM deduction_payments WHERE technician_id=?').get(technicianId).total || 0);
  let available = Math.max(0, gross - paid);
  if (!available) return 0;
  let settled = 0;
  const rows = db.prepare(`SELECT d.id,d.amount_cents,COALESCE((SELECT SUM(amount_cents) FROM deduction_payments p WHERE p.deduction_id=d.id),0) AS paid_cents FROM deductions d WHERE d.responsible_technician_id=? ORDER BY d.id`).all(technicianId);
  for (const row of rows) {
    const outstanding = Math.max(0, row.amount_cents - Number(row.paid_cents || 0));
    const amount = Math.min(available, outstanding);
    if (!amount) continue;
    db.prepare('INSERT INTO deduction_payments(deduction_id,technician_id,amount_cents,created_at) VALUES(?,?,?,?)').run(row.id, technicianId, amount, at);
    available -= amount; settled += amount;
    if (!available) break;
  }
  return settled;
}
function deductionSummary(technicianId) {
  const row = db.prepare(`SELECT COALESCE(SUM(d.amount_cents),0) AS total, COALESCE((SELECT SUM(p.amount_cents) FROM deduction_payments p WHERE p.technician_id=?),0) AS paid FROM deductions d WHERE d.responsible_technician_id=?`).get(technicianId, technicianId);
  const gross=Number(db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS total FROM ledger WHERE technician_id=? AND kind IN ('wage','wage_reversal')").get(technicianId).total||0);
  // 工价冲销后，原已扣款超过剩余工资的部分仍需从以后工价抵扣。
  return { total_cents: Number(row.total || 0), paid_cents: Number(row.paid || 0), pending_cents: Math.max(0, Number(row.total || 0) - Number(row.paid || 0)) + Math.max(0, Number(row.paid || 0)-gross) };
}
function statusLabel(status) { return ({active:'维修中',pending:'待维修',completed:'已完成',returned:'已退机',cancelled:'已取消'}[status] || status); }
function json(res, status, data) { const body = JSON.stringify(data); res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'}); res.end(body); }
function clientKey(req, username) { return `${req.socket.remoteAddress || 'unknown'}|${String(username || '').trim().toLowerCase()}`; }
function checkLoginRate(req, username) { const key=clientKey(req,username), row=loginFailures.get(key), current=Date.now(); if(!row||current-row.startedAt>=LOGIN_WINDOW_MS){loginFailures.delete(key);return} if(row.count>=LOGIN_FAILURE_LIMIT) bad(429,'登录失败次数过多，请 15 分钟后重试'); }
function recordLoginFailure(req, username) { const key=clientKey(req,username), current=Date.now(), row=loginFailures.get(key); if(!row||current-row.startedAt>=LOGIN_WINDOW_MS) loginFailures.set(key,{startedAt:current,count:1}); else row.count+=1; if(loginFailures.size>10000){for(const [k,v] of loginFailures){if(current-v.startedAt>=LOGIN_WINDOW_MS) loginFailures.delete(k);if(loginFailures.size<=8000) break;}} }
function clearLoginFailures(req, username) { loginFailures.delete(clientKey(req,username)); }
async function body(req) {
  if(req.parsedBody!==undefined) return req.parsedBody;
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) bad(413,'请求过大'); }
  if (!raw) return {};
  const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  let parsed; try { parsed = JSON.parse(raw); } catch { bad(400,'JSON 格式错误'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) bad(400,'请求内容必须为对象');
  return parsed;
}
const publicDir = path.join(__dirname,'public');
function serveStatic(req,res,url) {
  const page = {'/':'entry.html','/entry':'entry.html','/shouji':'index.html','/chaojishouji':'index.html','/shifu':'technician.html'}[url.pathname];
  const relative = page || (url.pathname.startsWith('/repair-assets/') ? url.pathname.slice('/repair-assets/'.length) : null);
  if (!relative) bad(404,'不存在');
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(publicDir + path.sep) && file !== path.join(publicDir,'index.html')) bad(404,'不存在');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) bad(404,'不存在');
  const ext = path.extname(file);
  const contentType = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[ext] || 'application/octet-stream';
  res.writeHead(200, {'Content-Type': contentType, 'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});
  fs.createReadStream(file).pipe(res);
}
async function api(req,res,url) {
  const route = url.pathname.replace(/^\/(api|repair-api)/,''), method = req.method;
  if (route === '/health' && method === 'GET') return json(res,200,{ok:true});
  if (route === '/register' && method === 'POST') {
    limitAuth(req,route);
    const b = await body(req), username = required(b.username,'用户名'), password = required(b.password,'密码');
    if (username.length>32 || /[\x00-\x1f\x7f]/.test(username)) bad(400,'账号格式无效（最多 32 字）');
    if (password.length < 5 || password.length>128) bad(400,'密码须为 5 至 128 位');
    try { const id = db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,'technician',?)").run(username,hashPassword(password),now()).lastInsertRowid; audit(Number(id),'user',Number(id),'registered'); return json(res,201,{message:'注册成功，等待管理员审核'}); } catch (e) { if (e.code?.startsWith('SQLITE_CONSTRAINT')) bad(409,'用户名已存在'); throw e; }
  }
  if (route === '/login' && method === 'POST') {
    limitAuth(req,route);
    const b = await body(req), username = required(b.username,'用户名');
    if(username.length>32 || String(b.password||'').length>128) bad(400,'账号或密码长度超出范围');
    checkLoginRate(req, username);
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!u || !checkPassword(String(b.password || ''),u.pass_hash)) { recordLoginFailure(req, username); bad(401,'用户名或密码错误'); }
    if (!u.approved || !u.active) bad(403,'账号待审核或已停用');
    clearLoginFailures(req, username);
    const client = sessionClients.has(String(b.client || '').trim().toLowerCase()) ? String(b.client).trim().toLowerCase() : 'unknown';
    if (client === 'superadmin' && !u.is_superadmin) bad(403,'该账号不能登录超级管理员入口');
    if (client === 'admin' && u.is_superadmin) bad(403,'超级管理员请使用超级管理员入口登录');
    if (client === 'admin' && u.role === 'technician') bad(403,'师傅账号请使用师傅入口登录');
    if (client === 'technician' && u.role !== 'technician') bad(403,'该账号不能登录师傅端');
    const token = crypto.randomBytes(32).toString('hex');
    tx(()=>{
      db.prepare('DELETE FROM sessions WHERE user_id=? OR expires_at<=?').run(u.id,now());
      db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,client) VALUES(?,?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'),u.id,new Date(Date.now()+7*86400000).toISOString(),client);
      audit(u.id,'user',u.id,'login',{client});
    });
    return json(res,200,{token,user:cleanUser(u)});
  }
  actor(req);
  if(['POST','PATCH','DELETE'].includes(method)) req.parsedBody=await body(req);
  const user = actor(req);
  if (route === '/logout' && method === 'POST') {
    const token = (req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(token).digest('hex'));
    return json(res, 200, { ok: true });
  }
  if (route === '/me' && method === 'GET') return json(res,200,{user:cleanUser(user)});
  if (route === '/me' && method === 'PATCH') {
    allow(user,'admin');
    const b=await body(req), displayName=required(b.display_name,'显示名称'), username=required(b.username,'登录账号');
    if (displayName.length>32 || username.length>32 || /[\x00-\x1f\x7f]/.test(displayName+username)) bad(400,'名称或账号格式无效（最多 32 字）');
    const current=db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (username!==current.username && !checkPassword(String(b.current_password||''),current.pass_hash)) bad(403,'修改登录账号需要输入正确的当前密码');
    try {
      tx(()=>{ db.prepare('UPDATE users SET username=?,display_name=? WHERE id=?').run(username,displayName,user.id); audit(user.id,'user',user.id,'profile_updated',{old_username:current.username,username,old_display_name:current.display_name||current.username,display_name:displayName}); });
    } catch(e) { if(e.code?.includes('CONSTRAINT') || /UNIQUE constraint failed/.test(e.message)) bad(409,'登录账号已存在'); throw e; }
    return json(res,200,{user:cleanUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id))});
  }
  if (route === '/users' && method === 'GET') { allow(user,'admin','frontdesk'); const rows = db.prepare("SELECT id,username,display_name,role,vip_level,approved,active,is_superadmin,deleted_at,created_at FROM users ORDER BY id DESC").all().map(u=>({...u,display_name:u.display_name||u.username,role:u.is_superadmin?'superadmin':u.role})); return json(res,200,{users: user.role==='frontdesk' ? rows.filter(u=>u.role==='technician'&&u.approved&&u.active) : rows}); }
  if (route === '/users' && method === 'POST') { allow(user,'admin'); const b=await body(req), username=required(b.username,'用户名'), displayName=required(b.display_name||username,'显示名称'), password=required(b.password,'密码'); if(username.length>32||displayName.length>32||/[\x00-\x1f\x7f]/.test(username+displayName)) bad(400,'名称或账号格式无效（最多 32 字）'); if(password.length<5) bad(400,'密码至少 5 位'); if(!['frontdesk','technician','admin'].includes(b.role)) bad(400,'角色无效'); if(b.role==='admin'&&user.role!=='superadmin') bad(403,'只有超级管理员可以创建普通管理员'); const vip=b.role==='technician'?vipLevel(b.vip_level||'普通').name:'普通'; try { const id=db.prepare('INSERT INTO users(username,display_name,pass_hash,role,vip_level,approved,created_at) VALUES(?,?,?,?,?,1,?)').run(username,displayName,hashPassword(password),b.role,vip,now()).lastInsertRowid; audit(user.id,'user',Number(id),'created',{role:b.role,username,display_name:displayName,vip_level:vip}); return json(res,201,{id:Number(id)}); } catch(e){ if(e.code?.startsWith('SQLITE_CONSTRAINT')) bad(409,'用户名已存在'); throw e; } }
  let match=route.match(/^\/users\/(\d+)$/);
  if(match && method==='DELETE') { allow(user,'admin'); const target=db.prepare('SELECT * FROM users WHERE id=?').get(Number(match[1])); if(!target) bad(404,'账号不存在'); if(target.id===user.id) bad(400,'不能删除当前登录账号'); if(target.is_superadmin) bad(403,'不能删除超级管理员账号'); if(target.role==='admin'&&user.role!=='superadmin') bad(403,'只有超级管理员可以删除普通管理员'); if(target.deleted_at) bad(409,'账号已经删除'); const ts=now(); tx(()=>{ db.prepare('UPDATE users SET active=0,approved=0,deleted_at=? WHERE id=?').run(ts,target.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id); audit(user.id,'user',target.id,'deleted',{username:target.username,display_name:target.display_name,role:target.role}); }); return json(res,200,{ok:true}); }
  if(match && method==='PATCH') { allow(user,'admin'); const b=await body(req), target=db.prepare('SELECT * FROM users WHERE id=?').get(Number(match[1])); if(!target) bad(404,'账号不存在'); if(target.deleted_at) bad(409,'账号已经删除'); if(target.is_superadmin) bad(403,'不能修改超级管理员账号'); if(target.role==='admin'&&user.role!=='superadmin') bad(403,'只有超级管理员可以修改普通管理员'); const vip=target.role==='technician'?vipLevel(b.vip_level ?? target.vip_level).name:target.vip_level, approved=b.approved===undefined?target.approved:Number(!!b.approved), active=b.active===undefined?target.active:Number(!!b.active); db.prepare('UPDATE users SET vip_level=?,approved=?,active=? WHERE id=?').run(vip,approved,active,target.id); if(!active||!approved) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id); audit(user.id,'user',target.id,'updated',{vip_level:vip,approved,active}); return json(res,200,{user:cleanUser(db.prepare('SELECT * FROM users WHERE id=?').get(target.id))}); }
  if (route === '/vip-levels' && method === 'GET') { allow(user,'admin','frontdesk'); return json(res,200,{levels:db.prepare('SELECT id,name,discount_tenths FROM vip_levels ORDER BY discount_tenths DESC,id').all()}); }
  if (route === '/vip-levels' && method === 'POST') { allow(user,'admin'); const b=await body(req), name=required(b.name,'等级名称'), discount=100; if(name.length>32||/[\x00-\x1f\x7f]/.test(name)) bad(400,'等级名称最多 32 字且不能包含控制字符'); try { const id=db.prepare('INSERT INTO vip_levels(name,discount_tenths,created_at) VALUES(?,?,?)').run(name,discount,now()).lastInsertRowid; audit(user.id,'vip_level',Number(id),'created',{name}); return json(res,201,{id:Number(id)}); } catch(e){ if(e.code?.includes('CONSTRAINT')||/UNIQUE constraint failed/.test(e.message)) bad(409,'等级名称已存在'); throw e; } }
  match=route.match(/^\/vip-levels\/(\d+)$/);
  if (match && method === 'PATCH') { allow(user,'admin'); const before=db.prepare('SELECT * FROM vip_levels WHERE id=?').get(Number(match[1])); if(!before) bad(404,'VIP 等级不存在'); const b=await body(req), name=required(b.name ?? before.name,'等级名称'), discount=before.discount_tenths; if(name.length>32||/[\x00-\x1f\x7f]/.test(name)) bad(400,'等级名称最多 32 字且不能包含控制字符'); try { tx(()=>{ db.prepare('UPDATE vip_levels SET name=?,discount_tenths=? WHERE id=?').run(name,discount,before.id); if(name!==before.name) db.prepare("UPDATE users SET vip_level=? WHERE role='technician' AND vip_level=?").run(name,before.name); audit(user.id,'vip_level',before.id,'updated',{old_name:before.name,name}); }); return json(res,200,{level:{id:before.id,name,discount_tenths:discount}}); } catch(e){ if(e.code?.includes('CONSTRAINT')||/UNIQUE constraint failed/.test(e.message)) bad(409,'等级名称已存在'); throw e; } }
  if (route === '/catalog' && method === 'GET') return json(res,200,{models:db.prepare('SELECT * FROM models ORDER BY name').all(),plans:db.prepare('SELECT * FROM plans ORDER BY name').all()});
  if (route === '/catalog' && method === 'POST') { allow(user,'admin'); const b=await body(req), table=b.kind==='model'?'models':b.kind==='plan'?'plans':null; if(!table) bad(400,'类型无效'); const name=required(b.name,'名称'); db.prepare(`INSERT OR IGNORE INTO ${table}(name) VALUES(?)`).run(name); audit(user.id,table,null,'added',{name}); return json(res,201,{name}); }
  if (route === '/orders/lookup' && method === 'GET') { allow(user,'admin','frontdesk'); const serial=required(url.searchParams.get('serial'),'串码'); const rows=db.prepare(`SELECT o.id,o.serial,o.serial_last6,o.model,o.customer,o.status,o.created_at,o.updated_at,i.id AS item_id,i.plan,i.status AS item_status,i.technician_id,u.display_name AS technician_name FROM orders o JOIN items i ON i.order_id=o.id JOIN users u ON u.id=i.technician_id WHERE o.serial=? OR o.serial_last6=? ORDER BY o.id DESC,i.id DESC`).all(serial,serial); const match=rows.find(row=>row.serial===serial)||null; return json(res,200,{match, matches:rows}); }
  if (route === '/orders' && method === 'POST') { allow(user,'admin','frontdesk'); const b=await body(req), serial=required(b.serial,'完整串码'), model=required(b.model,'型号'), customer=required(b.customer,'客户'); if(serial.length<6) bad(400,'串码至少 6 位'); const id=mutation(req,user,b,()=>{ const ts=now(); const orderId=Number(db.prepare('INSERT INTO orders(serial,serial_last6,model,customer,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(serial,serial.slice(-6),model,customer,user.id,ts,ts).lastInsertRowid); db.prepare('INSERT OR IGNORE INTO models(name) VALUES(?)').run(model); addItem(orderId,b,user.id); audit(user.id,'order',orderId,'created',{serial,model,customer}); return orderId; }); return json(res,201,{order:getOrder(id)}); }
  if (route === '/orders' && method === 'GET') { const q=(url.searchParams.get('q')||'').trim(), status=url.searchParams.get('status')||'', rows=db.prepare(`SELECT o.*,GROUP_CONCAT(DISTINCT COALESCE(NULLIF(u.display_name,''),u.username)) AS technician_names,COUNT(i.id) AS item_count,SUM(CASE WHEN i.status='completed' THEN 1 ELSE 0 END) AS completed_count FROM orders o JOIN items i ON i.order_id=o.id JOIN users u ON u.id=i.technician_id WHERE (?='' OR o.serial LIKE ? OR o.serial_last6 LIKE ? OR o.model LIKE ?) AND (?='' OR o.status=?) AND (?=0 OR (i.technician_id=? AND i.superseded_by IS NULL)) GROUP BY o.id ORDER BY o.id DESC`).all(q,`%${q}%`,`%${q}%`,`%${q}%`,status,status,user.role==='technician'?user.id:0,user.id); return json(res,200,{orders:rows}); }
  match=route.match(/^\/orders\/(\d+)$/);
  if(match && method==='PATCH') { allow(user,'admin','frontdesk'); const b=await body(req), customer=required(b.customer,'新客户姓名'), order=db.prepare('SELECT * FROM orders WHERE id=?').get(Number(match[1])); if(!order) bad(404,'订单不存在'); const old=order.customer; tx(()=>{ db.prepare('UPDATE orders SET customer=?,updated_at=? WHERE id=?').run(customer,now(),order.id); audit(user.id,'order',order.id,'customer_updated',{old_customer:old,customer}); }); return json(res,200,{order:getOrder(order.id)}); }
  if(match && method==='GET') return json(res,200,{order:visibleOrder(user,Number(match[1]))});
  match=route.match(/^\/orders\/(\d+)\/items$/);
  if(match && method==='POST') { allow(user,'admin','frontdesk'); const b=await body(req), orderId=Number(match[1]); const itemId=mutation(req,user,b,()=>{ const order=getOrder(orderId); if(order.status!=='active') bad(409,'订单已退机或取消'); const id=addItem(orderId,b,user.id); db.prepare('UPDATE orders SET updated_at=? WHERE id=?').run(now(),orderId); return id; }); return json(res,201,{item_id:itemId,order:getOrder(orderId)}); }
  match=route.match(/^\/items\/(\d+)\/assign$/);
  if(match && method==='POST') { allow(user,'admin','frontdesk'); const b=await body(req), t=technician(b.technician_id), reason=required(b.reason,'转派原因'), id=Number(match[1]); if(!reason) bad(400,'转派原因不能为空'); const item=db.prepare('SELECT i.*,o.status AS order_status FROM items i JOIN orders o ON o.id=i.order_id WHERE i.id=?').get(id); if(!item) bad(404,'维修项目不存在'); if(item.order_status!=='active') bad(409,'订单已关闭，不能转派'); if(item.superseded_by) bad(409,'该项目已转派，请操作新的维修项目'); if(item.technician_id===t.id) bad(400,'请选择其他师傅'); const ts=now(); const result=tx(()=>{ db.prepare('INSERT INTO assignment_history(item_id,from_technician_id,to_technician_id,reason,old_wage_cents,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(id,item.technician_id,t.id,reason,item.wage_cents,user.id,ts); if(item.status==='pending'){ db.prepare('UPDATE items SET technician_id=? WHERE id=?').run(t.id,id); } else if(item.status==='completed'){ const newId=Number(db.prepare("INSERT INTO items(order_id,plan,charge_cents,wage_cents,technician_id,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run(item.order_id,`售后：${item.plan}`,0,item.wage_cents,t.id,ts).lastInsertRowid); db.prepare("INSERT INTO ledger(item_id,kind,amount_cents,technician_id,created_at) VALUES(?,'wage_reversal',?,?,?)").run(id,-item.wage_cents,item.technician_id,ts); db.prepare('UPDATE items SET superseded_by=? WHERE id=?').run(newId,id); audit(user.id,'item',newId,'created',{order_id:item.order_id,plan:`售后：${item.plan}`,wage_cents:item.wage_cents,technician_id:t.id}); } else bad(409,'当前项目不能转派'); db.prepare('UPDATE orders SET updated_at=? WHERE id=?').run(ts,item.order_id); audit(user.id,'item',id,'reassigned',{from:item.technician_id,to:t.id,reason,old_wage_cents:item.wage_cents,status:item.status}); return getOrder(item.order_id); }); return json(res,200,{order:result}); }
  match=route.match(/^\/items\/(\d+)\/price$/);
  if(match && method==='PATCH') { allow(user,'admin','frontdesk'); const b=await body(req), id=Number(match[1]); const item=db.prepare('SELECT i.*,o.status AS order_status FROM items i JOIN orders o ON o.id=i.order_id WHERE i.id=?').get(id); if(!item) bad(404,'维修项目不存在'); if(item.status!=='pending'||item.order_status!=='active') bad(409,'只能修改未完成项目'); const charge=money(b.charge,'收费'), wage=money(b.wage,'工价'); tx(()=>{ db.prepare('UPDATE items SET charge_cents=?,wage_cents=? WHERE id=?').run(charge,wage,id); audit(user.id,'item',id,'price_changed',{old_charge_cents:item.charge_cents,old_wage_cents:item.wage_cents,charge_cents:charge,wage_cents:wage}); }); return json(res,200,{order:getOrder(item.order_id)}); }
  match=route.match(/^\/items\/(\d+)\/complete$/);
  if(match && method==='POST') { allow(user,'technician'); const id=Number(match[1]); const result=tx(()=>{ const item=db.prepare('SELECT i.*,o.status AS order_status FROM items i JOIN orders o ON o.id=i.order_id WHERE i.id=?').get(id); if(!item) bad(404,'维修项目不存在'); if(item.technician_id!==user.id||item.superseded_by) bad(403,'项目未分配给你或已转派'); if(item.status==='completed') return {already_completed:true,order:visibleOrder(user,item.order_id)}; if(item.status!=='pending'||item.order_status!=='active') bad(409,'项目不可完成'); const ts=now(); db.prepare("UPDATE items SET status='completed',completed_at=?,charge_snapshot_cents=charge_cents,wage_snapshot_cents=wage_cents,completed_by=? WHERE id=? AND status='pending'").run(ts,user.id,id); db.prepare("INSERT INTO ledger(item_id,kind,amount_cents,technician_id,created_at) VALUES(?,'charge',?,?,?)").run(id,item.charge_cents,user.id,ts); db.prepare("INSERT INTO ledger(item_id,kind,amount_cents,technician_id,created_at) VALUES(?,'wage',?,?,?)").run(id,item.wage_cents,user.id,ts); settleDeductions(user.id,ts); db.prepare('UPDATE orders SET updated_at=? WHERE id=?').run(ts,item.order_id); audit(user.id,'item',id,'completed',{charge_cents:item.charge_cents,wage_cents:item.wage_cents}); return {already_completed:false,order:visibleOrder(user,item.order_id)}; }); return json(res,200,result); }
  match=route.match(/^\/orders\/(\d+)\/(return|cancel)$/);
  if(match && method==='POST') { allow(user,'admin','frontdesk'); const id=Number(match[1]), target=match[2]==='return'?'returned':'cancelled'; const order=tx(()=>{ const o=getOrder(id); if(o.status!== 'active') bad(409,'订单已关闭'); const ts=now(); for(const i of o.items){ if(i.status==='completed'){ db.prepare("INSERT INTO ledger(item_id,kind,amount_cents,technician_id,created_at) VALUES(?,'charge_reversal',?,?,?)").run(i.id,-i.charge_snapshot_cents,i.technician_id,ts); db.prepare("INSERT OR IGNORE INTO ledger(item_id,kind,amount_cents,technician_id,created_at) VALUES(?,'wage_reversal',?,?,?)").run(i.id,-i.wage_snapshot_cents,i.technician_id,ts); } db.prepare('UPDATE items SET status=? WHERE id=?').run(target,i.id); } db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(target,ts,id); audit(user.id,'order',id,target,{items:o.items.length}); return getOrder(id); }); return json(res,200,{order}); }
  if (route === '/deductions' && method === 'POST') { allow(user,'admin','frontdesk'); const b=await body(req), responsible=technician(b.responsible_technician_id), amount=money(b.amount,'扣款金额'), reason=required(b.reason,'扣款原因'), kind=required(b.kind||'责任扣款','扣款类型'), orderId=b.order_id?Number(b.order_id):null, itemId=b.item_id?Number(b.item_id):null, beneficiary=b.beneficiary_technician_id?technician(b.beneficiary_technician_id):null; if(!amount) bad(400,'扣款金额必须大于 0'); if(orderId && !db.prepare('SELECT id FROM orders WHERE id=?').get(orderId)) bad(404,'订单不存在'); if(itemId){const linked=db.prepare('SELECT order_id FROM items WHERE id=?').get(itemId); if(!linked||!orderId||linked.order_id!==orderId) bad(400,'维修项目与关联订单不匹配');} const ts=now(); const id=mutation(req,user,b,()=>{const deductionId=Number(db.prepare('INSERT INTO deductions(order_id,item_id,responsible_technician_id,beneficiary_technician_id,kind,reason,amount_cents,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(orderId,itemId,responsible.id,beneficiary?.id||null,kind,reason,amount,user.id,ts).lastInsertRowid); settleDeductions(responsible.id,ts); audit(user.id,'deduction',deductionId,'created',{order_id:orderId,item_id:itemId,responsible_technician_id:responsible.id,beneficiary_technician_id:beneficiary?.id||null,kind,reason,amount_cents:amount}); return deductionId;}); return json(res,201,{deduction_id:id}); }
  if (route === '/deductions' && method === 'GET') { allow(user,'admin'); const tech=Number(url.searchParams.get('technician_id')||0); const rows=db.prepare(`SELECT d.*,o.serial,o.model,i.plan,u.display_name AS responsible_name,b.display_name AS beneficiary_name,MIN(d.amount_cents,MAX(0,COALESCE((SELECT SUM(l.amount_cents) FROM ledger l WHERE l.technician_id=d.responsible_technician_id AND l.kind IN ('wage','wage_reversal')),0)-COALESCE((SELECT SUM(older.amount_cents) FROM deductions older WHERE older.responsible_technician_id=d.responsible_technician_id AND older.id<d.id),0))) AS paid_cents FROM deductions d LEFT JOIN orders o ON o.id=d.order_id LEFT JOIN items i ON i.id=d.item_id JOIN users u ON u.id=d.responsible_technician_id LEFT JOIN users b ON b.id=d.beneficiary_technician_id WHERE (?=0 OR d.responsible_technician_id=?) ORDER BY d.id DESC`).all(tech,tech).map(d=>({...d,pending_cents:Math.max(0,d.amount_cents-Number(d.paid_cents||0))})); return json(res,200,{deductions:rows}); }
  if(route==='/finance' && method==='GET') { allow(user,'admin'); const from=url.searchParams.get('from')||'0000-01-01', to=url.searchParams.get('to')||'9999-12-31', tech=Number(url.searchParams.get('technician_id')||0), serial=url.searchParams.get('serial')||''; const like=`%${serial}%`; const entries=db.prepare(`SELECT l.id,l.kind,l.amount_cents,l.technician_id,l.created_at,i.plan,o.serial,o.model,u.username AS technician_name,u.display_name AS technician_display_name FROM ledger l JOIN items i ON i.id=l.item_id JOIN orders o ON o.id=i.order_id LEFT JOIN users u ON u.id=l.technician_id WHERE date(l.created_at,'+8 hours')>=? AND date(l.created_at,'+8 hours')<=? AND (?=0 OR l.technician_id=?) AND (?='' OR o.serial LIKE ?)`).all(from,to,tech,tech,serial,like); const deductionEntries=db.prepare(`SELECT -d.id AS id,'responsibility_deduction' AS kind,-d.amount_cents AS amount_cents,d.responsible_technician_id AS technician_id,d.created_at,COALESCE(i.plan,d.kind) AS plan,COALESCE(o.serial,'') AS serial,COALESCE(o.model,'') AS model,u.username AS technician_name,u.display_name AS technician_display_name FROM deductions d LEFT JOIN items i ON i.id=d.item_id LEFT JOIN orders o ON o.id=d.order_id JOIN users u ON u.id=d.responsible_technician_id WHERE date(d.created_at,'+8 hours')>=? AND date(d.created_at,'+8 hours')<=? AND (?=0 OR d.responsible_technician_id=?) AND (?='' OR o.serial LIKE ?)`).all(from,to,tech,tech,serial,like); entries.push(...deductionEntries); entries.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))); const charge=entries.filter(e=>e.kind.startsWith('charge')).reduce((s,e)=>s+e.amount_cents,0), wage=entries.filter(e=>e.kind.startsWith('wage')).reduce((s,e)=>s+e.amount_cents,0), deductions=entries.filter(e=>e.kind==='responsibility_deduction').reduce((s,e)=>s+Math.abs(e.amount_cents),0); return json(res,200,{charge_cents:charge,wage_cents:wage,deduction_cents:deductions,net_cents:charge-wage+deductions,entries}); }
  if(route==='/stats' && method==='GET') {
    allow(user,'technician');
    const rows=db.prepare("SELECT i.id,i.status,i.completed_at,l.amount_cents,l.created_at FROM items i LEFT JOIN ledger l ON l.item_id=i.id AND l.kind IN ('wage','wage_reversal') WHERE i.technician_id=?").all(user.id);
    const debts=db.prepare('SELECT amount_cents,created_at FROM deductions WHERE responsible_technician_id=?').all(user.id);
    const today=localDay(), dayOf=s=>s?new Date(new Date(s).getTime()+8*3600000).toISOString().slice(0,10):'';
    const gross=rows.reduce((n,r)=>n+(r.amount_cents||0),0), debt=debts.reduce((n,r)=>n+r.amount_cents,0);
    const effectivePaid=Math.min(Math.max(0,gross),debt);
    const summarize=prefix=>{
      const beforeGross=prefix?rows.filter(r=>dayOf(r.created_at)&&dayOf(r.created_at).slice(0,prefix.length)<prefix).reduce((n,r)=>n+(r.amount_cents||0),0):0;
      const beforeDebt=prefix?debts.filter(r=>dayOf(r.created_at).slice(0,prefix.length)<prefix).reduce((n,r)=>n+r.amount_cents,0):0;
      const periodGross=gross-beforeGross, paid=effectivePaid-Math.min(Math.max(0,beforeGross),beforeDebt);
      return {wage_cents:Math.max(0,periodGross-paid),gross_wage_cents:periodGross,deduction_paid_cents:paid,pending_deduction_cents:Math.max(0,debt-gross),count:new Set(rows.filter(r=>r.status==='completed'&&dayOf(r.completed_at).startsWith(prefix)).map(r=>r.id)).size};
    };
    return json(res,200,{today:summarize(today),month:summarize(today.slice(0,7)),total:summarize('')});
  }
  if(route==='/audit' && method==='GET') { allow(user,'admin'); const entries=db.prepare('SELECT a.*,u.username AS actor_name,u.display_name AS actor_display_name,u.role,u.is_superadmin FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC').all().map(row=>({...row,message:operationMessage(row)})); return json(res,200,{entries}); }
  bad(404,'接口不存在');
}
function backup() { const dir=path.join(DATA_DIR,'backups'); fs.mkdirSync(dir,{recursive:true}); const file=path.join(dir,`repair-${localDay()}.sqlite`); if(!fs.existsSync(file)) { try { db.prepare('VACUUM INTO ?').run(file); } catch(e) { console.error('备份失败:',e); if(fs.existsSync(file)) fs.rmSync(file,{force:true}); } } }
backup(); setInterval(backup,60*60*1000).unref();
const server=http.createServer(async(req,res)=>{ try { const url=new URL(req.url,'http://localhost'); if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/repair-api/')) await api(req,res,url); else if(req.method==='GET') serveStatic(req,res,url); else bad(404,'不存在'); } catch(e){ if(e.status) json(res,e.status,{error:e.message}); else { console.error(e); json(res,500,{error:'服务器错误'}); } } });
if(require.main===module) server.listen(PORT,HOST,()=>console.log(`管理后台: http://${HOST}:${server.address().port}/shouji`));
module.exports={server,db};
