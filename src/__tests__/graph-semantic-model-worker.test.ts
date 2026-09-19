import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDisposableTestDbUrl } from './test-db-url.js';
const execute=promisify(execFile);
it('runs the actual model worker and keeps owner deadlines, lease loss and cancellation effective under synchronous blocking',async()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const {stdout}=await execute(process.execPath,[path.join(root,'scripts/test-semantic-model-worker.mjs')],{
    cwd:root,env:{...process.env,MAI_TEST_DB_URL:requireDisposableTestDbUrl()},timeout:85000,maxBuffer:1024*1024,
  });
  const report:unknown=JSON.parse(stdout);
  expect(report).toMatchObject({protocolPassed:true,passed:true,controls:[
    {phase:'load',action:'deadline',passed:true},
    {phase:'inference',action:'deadline',passed:true},
    {phase:'close',action:'deadline',passed:true},
    {phase:'inference',action:'lease-loss',passed:true},
    {phase:'inference',action:'native-lease-loss',passed:true},
    {phase:'inference',action:'parent-death',passed:true},
    {phase:'inference',action:'cancel',passed:true},
  ]});
},90000);
