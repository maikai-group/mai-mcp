export interface ScoredCandidate { identity: string; nodeId: string; score: number }
export function fuseRanks<T extends {identity:string}>(first: readonly T[], second: readonly T[]): T[] {
  const ranks=new Map(second.map((item,index)=>[item.identity,index+1]));
  if (ranks.size!==first.length||new Set(first.map(item=>item.identity)).size!==first.length
    ||first.some(item=>!ranks.has(item.identity))) throw new Error('Rank fusion requires identical unique candidates');
  return first.map((item,index)=>({item,rank:index+1,
    score:1/(60+index+1)+1/(60+(ranks.get(item.identity)??Infinity))}))
    .sort((a,b)=>b.score-a.score||a.rank-b.rank).map(({item})=>item);
}
export function fuseReranked<T extends {identity:string}>(first: readonly T[], logits: readonly number[]): T[] {
  const candidates=first.slice(0,8);
  if (logits.length!==candidates.length||!logits.every(Number.isFinite)) throw new Error('Invalid reranker output');
  const ordered=candidates.map((item,index)=>({item,index,score:logits[index]}))
    .sort((a,b)=>b.score-a.score||a.index-b.index).map(({item})=>item);
  return [...fuseRanks(candidates,ordered),...first.slice(8)];
}
// null means verification ran out of time; it is not proof of a missing row.
export async function supplementCurrent<T extends {id:string}>(
  semantic:readonly T[],lexical:readonly T[],limit:number,isCurrent:(hit:T)=>Promise<boolean|null>,
):Promise<T[]> {
  const selected=new Set(semantic.map(hit=>hit.id));
  const candidates=lexical.filter(hit=>!selected.has(hit.id));
  const missing:T[]=[];
  for(const hit of candidates)if(await isCurrent(hit)===false)missing.push(hit);
  const reserve=semantic.length>0&&limit>1&&missing.length>0?1:0;
  const missingIds=new Set(missing.map(hit=>hit.id));
  return [...semantic.slice(0,limit-reserve),...missing,...candidates.filter(hit=>!missingIds.has(hit.id))].slice(0,limit);
}
export function vectorIsValid(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value) && value.length === dimensions
    && value.every(v => typeof v === 'number' && Number.isFinite(v))
    && value.some(v => v !== 0);
}
export async function retainCurrent<T>(
  candidates: readonly ScoredCandidate[], limit: number,
  hydrate: (candidate: ScoredCandidate) => Promise<T | null>, expired: () => boolean,
): Promise<T[]> {
  const sorted = [...candidates].sort((a,b) => b.score-a.score || a.identity.localeCompare(b.identity));
  const results: T[] = [];
  for (const candidate of sorted) {
    if (expired() || results.length === limit) break;
    const current = await hydrate(candidate);
    if (current !== null) results.push(current);
  }
  return results;
}
