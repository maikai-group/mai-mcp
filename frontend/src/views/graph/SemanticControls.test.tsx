import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SemanticControls } from './SemanticControls';
import type { SemanticStatus } from './semantic-types';
const fake=vi.hoisted(()=>({project:'alpha',get:vi.fn(),post:vi.fn()}));
vi.mock('../../lib/api',()=>({apiGet:fake.get,apiPost:fake.post,getProject:()=>fake.project}));
const status:SemanticStatus={policy:{provider:'local',revision:0,consentVersion:null},model:null,coverage:{eligible:0,current:0,skipped:0,capped:false,declaration:{eligible:0,current:0},metadata:{eligible:0,current:0},complete:false},job:null};
beforeEach(()=>{fake.project='alpha';fake.get.mockReset().mockResolvedValue(status);fake.post.mockReset().mockResolvedValue({});});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('requires unchecked explicit cloud consent and never starts indexing on provider save',async()=>{
  await act(async()=>{render(<SemanticControls project="alpha"/>);});
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'openai'}});
  const checkbox=screen.getByRole('checkbox');expect(checkbox instanceof HTMLInputElement&&checkbox.checked).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Save provider'}));expect(fake.post).not.toHaveBeenCalled();
  fireEvent.click(checkbox);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Save provider'})));
  expect(fake.post).toHaveBeenCalledExactlyOnceWith('/graph/semantic/policy',{provider:'openai',expectedRevision:0,acknowledgeCodeUpload:true});
});
it('keeps failed mutations visible',async()=>{
  fake.post.mockRejectedValue(new Error('key missing'));await act(async()=>{render(<SemanticControls project="alpha"/>);});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Build / Resume index'})));expect(screen.getByRole('alert').textContent).toBe('key missing');
});
it('stops running-job polling after unmount',async()=>{
  vi.useFakeTimers();fake.get.mockResolvedValue({...status,job:{id:'job',state:'running',scanned:1,written:0,reused:0,skipped:0,reason:null}});
  let view:ReturnType<typeof render>|undefined;await act(async()=>{view=render(<SemanticControls project="alpha"/>);});
  expect(fake.get).toHaveBeenCalledTimes(1);view?.unmount();await act(()=>vi.advanceTimersByTimeAsync(6000));expect(fake.get).toHaveBeenCalledTimes(1);
});
it('rejects a stale project action before sending it',async()=>{
  await act(async()=>{render(<SemanticControls project="alpha"/>);});fake.project='beta';
  fireEvent.click(screen.getByRole('button',{name:'Build / Resume index'}));expect(fake.post).not.toHaveBeenCalled();
});
