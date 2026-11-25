import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'surfcore-model-settings-'));
const configFile=path.join(dir,'config.json');
const sample={other:{neverAlter:true},dsh:{qqEngine:'openai-api',authToken:'fixture-masked-here',model:'deepseek-flash'}};
try {
  fs.mkdirSync(path.join(dir,'src'));fs.writeFileSync(path.join(dir,'src','bridge.js'),'');
  fs.writeFileSync(configFile,JSON.stringify(sample));
  process.env.SURFCORE_ROOT=dir;process.env.DSH_HOME=path.join(dir,'dsh');
  const {saveQqModelSettings,readQqConfig}=await import('../plugins/surfcore/lib/store.js');
  const before={qqEngine:'openai-api',model:'deepseek-flash'};
  const changed=saveQqModelSettings({qqOpenAiModel:'gpt-4o'},before);
  assert.equal(changed.qqOpenAiModel,'gpt-4o');
  assert.equal(readQqConfig().config.dsh.qqOpenAiModel,'gpt-4o');
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile,'utf8')),{...sample,dsh:{...sample.dsh,qqOpenAiModel:'gpt-4o'}});
  assert.throws(()=>saveQqModelSettings({qqOpenAiModel:'chat-latest'},before),/被其他窗口修改/);
  assert.throws(()=>saveQqModelSettings({authToken:'should-not-write'},changed),/无效的模型设置/);
  assert.throws(()=>saveQqModelSettings({qqOpenAiModel:'gpt-4o-realtime-preview'},changed),/兼容性未确认/);
  const next=saveQqModelSettings({qqOpenAiModel:'gpt-6.2-sol',qqOpenAiEffort:'medium'},changed);
  assert.equal(readQqConfig().config.dsh.qqOpenAiEffort,'medium');
  assert.throws(()=>saveQqModelSettings({qqOpenAiEffort:'none'},next),/思考强度无效/);
  assert.throws(()=>saveQqModelSettings({qqEngine:'modelsnexus'},next),/请选择 ModelsNexus/);
  const nexus=saveQqModelSettings({qqEngine:'modelsnexus',qqModelsNexusModel:'gemini-4-carbon'},next);
  assert.equal(nexus.qqOpenAiEffort,'medium');
  assert.equal(readQqConfig().config.dsh.qqModelsNexusModel,'gemini-4-carbon');
  assert.throws(()=>saveQqModelSettings({qqModelsNexusModel:'gpt-4o'},nexus),/请选择 ModelsNexus/);
  assert.throws(()=>saveQqModelSettings({CLAUDE_KEY:'should-not-write'},nexus),/无效的模型设置/);
  const switched=saveQqModelSettings({qqEngine:'openai-api'},nexus);
  assert.equal(switched.qqModelsNexusModel,'gemini-4-carbon');
  fs.writeFileSync(configFile,'damaged-json-fixture');
  assert.throws(()=>saveQqModelSettings({qqOpenAiModel:'gpt-4o'},switched),/无法安全读取/);
  assert.equal(fs.readFileSync(configFile,'utf8'),'damaged-json-fixture');
  console.log('QQ model-only save/reset/reopen and scope guards passed');
} finally {
  fs.rmSync(dir,{recursive:true,force:true});
}
