'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('网页扣款网络中断后沿用请求编号，成功后新操作换编号',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const values=new Map(),keys=[];let calls=0;
  const context=vm.createContext({state:{token:'token',user:{id:3}},client:'admin',AbortController,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto,
    sessionStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},
    fetch:async(url,options)=>{keys.push(options.headers['Idempotency-Key']);if(calls++===0)throw Error('断网');return {ok:true,status:201,json:async()=>({deduction_id:1})}}});
  vm.runInContext(source.slice(source.indexOf('function financialRequest'),source.indexOf('const formData=')),context);
  const send=()=>vm.runInContext("request('/deductions',{method:'POST',body:JSON.stringify({amount:'35'})})",context);
  await assert.rejects(send());await send();await send();
  assert.ok(keys[0]);assert.equal(keys[0],keys[1]);assert.notEqual(keys[1],keys[2]);
});

test('小程序入库断网重试沿用请求编号，成功后换编号',async()=>{
  const storage=new Map(),keys=[];let calls=0;
  const context=vm.createContext({module:{exports:{}},getApp:()=>({globalData:{token:'token',user:{id:3},apiBase:'http://test'}}),
    wx:{getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),request:options=>{keys.push(options.header['Idempotency-Key']);if(calls++===0)options.fail();else options.success({statusCode:201,data:{order:{id:1}}})}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../miniprogram/utils/api.js'),'utf8'),context);
  const send=()=>context.module.exports.request('/orders','POST',{wage:'35'});
  await assert.rejects(send());await send();await send();
  assert.ok(keys[0]);assert.equal(keys[0],keys[1]);assert.notEqual(keys[1],keys[2]);
});
