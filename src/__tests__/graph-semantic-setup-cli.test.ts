import { beforeEach, expect, it, vi } from 'vitest';
const fake=vi.hoisted(()=>({setup:vi.fn(),worker:vi.fn()}));
vi.mock('../graph/semantic/setup.js',()=>({setupCodeModels:fake.setup}));
vi.mock('../graph/semantic/service.js',()=>({scopedSearch:fake.worker,workerRequest:fake.worker,updateCodePolicy:fake.worker}));
const {semanticCli}=await import('../graph/semantic/cli.js');
beforeEach(()=>{fake.setup.mockReset();fake.worker.mockReset();fake.setup.mockResolvedValue({state:'ready'});});
it('routes explicit setup without a project lookup, worker, or index job',async()=>{
  expect(JSON.parse(await semanticCli({verb:'graph',positional:['semantic','setup-local'],flags:{}}))).toEqual({state:'ready'});
  expect(fake.setup).toHaveBeenCalledOnce();expect(fake.worker).not.toHaveBeenCalled();
});
it('rejects extra operands and flags before starting setup',async()=>{
  await expect(semanticCli({verb:'graph',positional:['semantic','setup-local','extra'],flags:{}})).rejects.toThrow();
  await expect(semanticCli({verb:'graph',positional:['semantic','setup-local'],flags:{project:'example'}})).rejects.toThrow();
  expect(fake.setup).not.toHaveBeenCalled();
});
