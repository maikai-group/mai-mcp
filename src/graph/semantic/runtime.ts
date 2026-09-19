import { cosineSim } from '../../embeddings.js';
import { getPool } from '../../db.js';
import { buildDocument, buildCachedDocument } from './document.js';
import { resolveNode } from './identity.js';
import { readPolicy } from './policy.js';
import { createCodeEmbedder, modelFor, type CodeEmbedder } from './provider.js';
import { candidateNodes, cacheRows, readJob, finishJob, saveDocument, latestJob, type IndexJob, type CacheRow } from './store.js';
import { retainCurrent, supplementCurrent, fuseRanks, fuseReranked, type ScoredCandidate } from './ranking.js';
import { completeVectors, currentVectors } from './cache.js';
import { cueEmbedding, type CueEmbedding } from './cues.js';
import { SemanticError } from './validation.js';
import { DOCUMENT_VERSION, LIMITS, type CodeSearch, type CodeHit, type SearchInput, type CodePolicy } from './types.js';

import { acquireLease, terminateInference } from './lease.js';
import { emptySearch } from './response.js';
export { emptySearch } from './response.js';
export async function lexicalSearch(projectId: string, input: SearchInput): Promise<CodeSearch> {
  const rows = await getPool().query<{id:string;name:string;kind:string;qualified_name:string;file_path:string|null;line:number|null;score:number}>(`SELECT id,name,kind,qualified_name,file_path,line,
    greatest(similarity(name,$2),similarity(coalesce(qualified_name,''),$2)) AS score FROM graph_nodes
    WHERE project_id=$1 AND ($3::text IS NULL OR kind=$3) AND
    (greatest(similarity(name,$2),similarity(coalesce(qualified_name,''),$2))>=0.15
      OR position(lower($2) in lower(name))>0 OR position(lower($2) in lower(coalesce(qualified_name,'')))>0)
    ORDER BY score DESC,name,id LIMIT $4`,[projectId,input.query,input.kind??null,input.limit]);
  const result = emptySearch('not_indexed');
  for (const row of rows.rows) {
    const node = await resolveNode(projectId,row.id);
    if (!node) continue;
    result.nodes.push({id:node.nodeId,identity:node.identity,name:row.name,kind:row.kind,
      qualified_name:row.qualified_name,file_path:node.physicalPath,line:row.line,score:row.score,
      method:'lexical',document_mode:null,excerpt:null,
      freshness:{state:'unverified',source_hash:null,document_fingerprint:null,document_version:null,indexed_at:null,verified_at:null}});
  }
  return result;
}
export { acquireLease, terminateInference, type WorkerLease } from './lease.js';
async function withProvider<T>(policy: CodePolicy, body: (provider:CodeEmbedder)=>Promise<T>): Promise<T|null> {
  const lease=await acquireLease(terminateInference);
  if(!lease)throw new SemanticError('worker_busy',409);
  let provider:CodeEmbedder|null=null;
  const hardTimeout=setTimeout(terminateInference,LIMITS.localMs);
  try {
    provider=await createCodeEmbedder(policy);
    clearTimeout(hardTimeout);
    return provider ? await body(provider) : null;
  } finally {
    clearTimeout(hardTimeout);
    const closingProvider=provider;
    if(closingProvider)await boundedInference(()=>closingProvider.close());
    await lease.close();
  }
}
async function boundedInference<T>(operation:()=>Promise<T>):Promise<T> {
  const timer=setTimeout(terminateInference,LIMITS.localMs);
  try{return await operation();}finally{clearTimeout(timer);}
}
export async function searchRuntime(projectId:string,input:SearchInput,publishLexical:(result:CodeSearch)=>void):Promise<CodeSearch> {
  const deadline=performance.now()+23000;
  const expired=()=>performance.now()>=deadline;
  const lexical=await lexicalSearch(projectId,input);
  publishLexical(lexical);
  const policy=await readPolicy(projectId), model=modelFor(policy);
  if(!model)return {...lexical,reasons:['off']};
  try {
    const semantic=await withProvider<CodeSearch>(policy,async provider=>{
      const query=await boundedInference(()=>provider.query(input.query));
      if(!query)return {...lexical,reasons:['provider_unavailable']};
      const census=await candidateNodes(projectId,input.kind);
      const nodes=new Map(census.nodes.map(node=>[node.identity,node]));
      let scores:ScoredCandidate[]=[];
      const cueScores:ScoredCandidate[]=[],local=policy.provider==='local';
      const evidence=new Map<string,CacheRow>();
      for(let offset=0;offset<census.nodes.length&&!expired();offset+=LIMITS.vectorPage){
        const identities=census.nodes.slice(offset,offset+LIMITS.vectorPage).map(node=>node.identity);
        for(const cached of await cacheRows(projectId,identities,model)){
          const node=nodes.get(cached.identity);
          if(!node||!completeVectors(cached,model))continue;
          const score=cosineSim(query,cached.embedding);
          if(!Number.isFinite(score)||(!local&&score<=0))continue;
          if(local){
            if(!cached.cue_embedding)continue;
            const cueScore=cosineSim(query,cached.cue_embedding);if(!Number.isFinite(cueScore))continue;
            cueScores.push({identity:cached.identity,nodeId:node.nodeId,score:cueScore});
          }
          scores.push({identity:cached.identity,nodeId:node.nodeId,score});
        }
      }
      if(local){
        const order=(a:ScoredCandidate,b:ScoredCandidate)=>b.score-a.score||a.identity.localeCompare(b.identity);
        scores=fuseRanks(scores.sort(order),cueScores.sort(order)).map((candidate,index)=>({...candidate,score:1/(index+1)}));
      }
      const result:CodeSearch={...emptySearch('not_indexed'),state:'partial',reasons:[],model};
      result.coverage.capped=census.capped;result.coverage.skipped=census.skipped;

      const documents=new Map<string,string>();
      result.nodes=await retainCurrent(scores,local?Math.max(8,input.limit):input.limit,async candidate=>{
        const node=await resolveNode(projectId,candidate.nodeId);
        const cached=(await cacheRows(projectId,[candidate.identity],model))[0];
        if(!node||node.identity!==candidate.identity||!cached)return null;
        const doc=await buildCachedDocument(node,cached);
        if(!doc)return null;
        if(!currentVectors(cached,doc,model))return null;
        evidence.set(node.identity,cached);
        documents.set(node.identity,doc.text);
        return {id:node.nodeId,identity:node.identity,name:node.name,kind:node.kind,qualified_name:node.qualifiedName,
          file_path:node.physicalPath,line:node.line,score:candidate.score,method:'semantic',document_mode:doc.mode,
          excerpt:doc.text.slice(0,LIMITS.excerptChars),freshness:{state:doc.mode==='declaration'?'verified':'metadata_only',
            source_hash:doc.sourceHash,document_fingerprint:doc.fingerprint,document_version:doc.version,
            indexed_at:cached.indexed_at.toISOString(),verified_at:new Date().toISOString()}} satisfies CodeHit;
      },expired);
      if(local&&result.nodes.length){
        const texts=result.nodes.slice(0,8).map(hit=>documents.get(hit.identity));
        if(!provider.rerank||texts.some(value=>value===undefined))return {...lexical,model,reasons:['provider_unavailable']};
        const boundedTexts=texts.filter((value):value is string=>value!==undefined);
        const logits=await boundedInference(()=>provider.rerank?provider.rerank(input.query,boundedTexts):Promise.resolve(null));
        if(!logits)return {...lexical,model,reasons:['provider_unavailable']};
        // Only numeric scores remain useful. Keep the lease, but release model
        // storage before coverage parsing and the final live-source checks.
        await boundedInference(()=>provider.close());
        result.nodes=fuseReranked(result.nodes,logits).slice(0,input.limit).map((hit,index)=>({...hit,score:1/(index+1)}));
      }
      if(expired())return {...lexical,model,reasons:['query_timeout']};
      result.coverage=await currentCoverage(projectId,model,Math.min(deadline-1000,performance.now()+1000),census);
      if(census.capped)result.reasons.push('corpus_limit');
      if(!result.coverage.complete&&!census.capped)result.reasons.push('coverage_incomplete');
      if(result.coverage.current<result.coverage.eligible||result.coverage.skipped>0)result.reasons.push('stale_source');
      if(!result.nodes.length)return {...lexical,model,coverage:result.coverage,reasons:['no_semantic_hits',...result.reasons]};
      result.nodes=await supplementCurrent(result.nodes,lexical.nodes,input.limit,async hit=>{
        if(expired())return null;
        const node=await resolveNode(projectId,hit.id);
        if(!node||node.identity!==hit.identity)return null;
        const row=(await cacheRows(projectId,[node.identity],model))[0];
        const document=row?await buildCachedDocument(node,row):null;
        if(!document){if(!result.reasons.includes('stale_source'))result.reasons.push('stale_source');return false;}
        const current=currentVectors(row,document,model);
        if(!current&&!result.reasons.includes('stale_source'))result.reasons.push('stale_source');
        return current;
      });
      if(result.coverage.complete&&!result.coverage.skipped&&result.coverage.current===result.coverage.eligible&&!result.reasons.includes('stale_source'))result.state='ready';
      if((await readPolicy(projectId)).revision!==policy.revision)return {...lexical,reasons:['policy_changed']};
      const current:CodeHit[]=[];
      for(const hit of result.nodes){
        const resolved=await resolveNode(projectId,hit.id);
        const document=resolved&&hit.method==='semantic'?await buildCachedDocument(resolved,evidence.get(hit.identity)):null;
        if(resolved?.identity===hit.identity&&(hit.method==='lexical'||document&&currentVectors(evidence.get(hit.identity),document,model)))current.push(hit);
        else {result.state='partial';result.reasons.push('stale_source');}
      }
      result.nodes=current;return result;
    });
    return semantic??{...lexical,reasons:[policy.provider==='local'?'model_missing':'provider_unavailable']};
  }catch(error){return {...lexical,reasons:[error instanceof SemanticError&&error.message==='worker_busy'?'worker_busy':'provider_unavailable']};}
}
export async function runIndex(projectId:string,jobId:string):Promise<void> {
  const {codeCues}=await import('./code-cues.js');
  const job=await readJob(projectId,jobId);if(!job||job.state!=='running')return;
  const policy=await readPolicy(projectId);
  let checking=false;
  const poll=setInterval(()=>{
    if(checking)return;checking=true;
    void readJob(projectId,jobId).then(async current=>{
      if(!current||current.state!=='running'||current.cancel_requested||(await readPolicy(projectId)).revision!==policy.revision)terminateInference();
      await getPool().query("UPDATE graph_code_jobs SET heartbeat_at=now() WHERE project_id=$1 AND id=$2 AND state='running'",[projectId,jobId]);
    }).catch(terminateInference).finally(()=>{checking=false;});
  },LIMITS.cancelPollMs);
  try{
    const worked=await withProvider(policy,async provider=>{
      if(policy.revision!==job.policy_revision||provider.model!==job.model)throw new SemanticError('policy_changed',409);
      const census=await candidateNodes(projectId);
      await getPool().query(`UPDATE graph_code_jobs SET scanned=scanned+$3,skipped=skipped+$3 WHERE project_id=$1 AND id=$2 AND state='running'`,[projectId,jobId,census.skipped]);
      for(const node of census.nodes){
        const current=await readJob(projectId,jobId);
        if(!current||current.state!=='running'||current.cancel_requested)terminateInference();
        const doc=await buildDocument(node);
        const old=doc?(await cacheRows(projectId,[doc.node.identity],provider.model))[0]:null;
        const reuse=!!doc&&currentVectors(old??undefined,doc,provider.model);
        const vector=doc?(reuse&&old?old.embedding:await boundedInference(()=>provider.document(doc.text))):null;
        let cue:CueEmbedding|null=null;
        if(doc&&vector&&policy.provider==='local'){
          const cueVector=reuse&&old?.cue_embedding?old.cue_embedding:doc.mode==='metadata'?vector
            :provider.cue?await boundedInference(()=>provider.cue?provider.cue(codeCues(doc)):Promise.resolve(null)):null;
          if(cueVector)cue=cueEmbedding(doc,cueVector);
        }
        const verified=doc?await buildDocument(node):null;
        await saveDocument(projectId,jobId,verified&&verified.fingerprint===doc?.fingerprint?verified:null,vector,reuse,cue);
      }
      const final=await candidateNodes(projectId);
      const unchanged=final.nodes.length===census.nodes.length&&final.nodes.every((node,i)=>node.identity===census.nodes[i].identity);
      const current=await readJob(projectId,jobId);
      const coverage=await currentCoverage(projectId,provider.model,Infinity,final);
      const partial=census.capped||census.skipped>0||!unchanged||!current||current.skipped>0||!coverage.complete||coverage.current!==coverage.eligible||coverage.skipped>0;
      await finishJob(projectId,jobId,partial?'partial':'completed',census.capped?'corpus_limit':partial?'stale_source':null);
      return true;
    });
    if(!worked)await finishJob(projectId,jobId,'partial','provider_unavailable');
  }catch(error){await finishJob(projectId,jobId,'partial',error instanceof SemanticError?error.message:'provider_unavailable');}
  finally{clearInterval(poll);}
}
export interface SemanticStatus { policy:CodePolicy;model:string|null;coverage:CodeSearch['coverage'];job:IndexJob|null }
export async function currentCoverage(projectId:string,model:string|null,deadline:number,
  supplied?:Awaited<ReturnType<typeof candidateNodes>>):Promise<CodeSearch['coverage']> {
  const census=supplied??await candidateNodes(projectId);
  const coverage=emptySearch('not_indexed').coverage;
  coverage.capped=census.capped;coverage.skipped=census.skipped;
  let examined=0;
  for(let offset=0;offset<census.nodes.length&&performance.now()<deadline;offset+=LIMITS.vectorPage){
    const page=census.nodes.slice(offset,offset+LIMITS.vectorPage);
    const cached=new Map((model?await cacheRows(projectId,page.map(node=>node.identity),model):[]).map(row=>[row.identity,row]));
    for(const node of page){
      if(performance.now()>=deadline)break;examined++;
      const row=cached.get(node.identity);
      const cachedDocument=row?await buildCachedDocument(node,row):null;
      const document=cachedDocument??await buildDocument(node);
      if(!document){coverage.skipped++;continue;}
      coverage.eligible++;coverage[document.mode].eligible++;
      if(model&&cachedDocument&&currentVectors(row,cachedDocument,model)){
        coverage.current++;coverage[document.mode].current++;
      }
    }
  }
  coverage.complete=!census.capped&&examined===census.nodes.length;
  return coverage;
}
export async function statusRuntime(projectId:string):Promise<SemanticStatus> {
  const policy=await readPolicy(projectId),model=modelFor(policy),job=await latestJob(projectId);
  return {policy,model,coverage:job?.state==='running'?emptySearch('not_indexed').coverage:await currentCoverage(projectId,model,performance.now()+20000),job};
}
