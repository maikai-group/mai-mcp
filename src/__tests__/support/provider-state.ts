// Every ordinary test-file environment owns its provider state; an absent env
// credential can never read the operator's real saved store.
import { afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const previous=process.env.MAI_STATE_HOME;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mai-test-provider-state-'));
process.env.MAI_STATE_HOME=root;
afterAll(()=>{
  if(previous===undefined)delete process.env.MAI_STATE_HOME;else process.env.MAI_STATE_HOME=previous;
  fs.rmSync(root,{recursive:true,force:true});
});
