'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('导出负数金额可以求和，文本列继续拦截表格公式',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const context=vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function csvCell('),source.indexOf('function exportCsv(')),context);
  assert.equal(context.csvCell('-20.00',true),'"-20.00"');
  assert.equal(context.csvCell('85.50',true),'"85.50"');
  assert.equal(context.csvCell('-20.00'),'"\'-20.00"');
  for(const value of ['=1+1','+SUM(A1:A2)','-1+2','@SUM(1)','\t=1']){
    assert.equal(context.csvCell(value),'"\''+value+'"');
    assert.equal(context.csvCell(value,true),'"\''+value+'"');
  }
  assert.equal(context.csvCell('屏幕"维修'),'"屏幕""维修"');
});
