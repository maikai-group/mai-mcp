import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RERANKER_FILES, rerankerDirectory } from './reranker-assets.js';
import { integer, object } from './validation.js';
import { verifyArtifact } from './artifact.js';

export interface CodeReranker { score(query:string,documents:readonly string[]):Promise<number[]>;close():Promise<void> }
export async function verifyReranker(directory: string): Promise<void> {
  for (const file of RERANKER_FILES) {
    await verifyArtifact(path.join(directory,file.file),file);
  }
}
async function weight(directory:string,file:string,key:string,shape:readonly number[]):Promise<Float32Array> {
  const bytes=await readFile(path.join(directory,file));
  const length=Number(bytes.readBigUInt64LE());
  integer(length,1,65536);
  const raw:unknown=JSON.parse(bytes.subarray(8,8+length).toString('utf8'));
  const header=object(raw,['__metadata__','linear.weight','linear.bias','norm.weight','norm.bias']);
  const item=object(header[key],['dtype','shape','data_offsets']);
  if (item.dtype!=='F32'||!Array.isArray(item.shape)||item.shape.length!==shape.length||item.shape.some((value,i)=>value!==shape[i])
    ||!Array.isArray(item.data_offsets)||item.data_offsets.length!==2) throw new Error('Invalid reranker head tensor');
  const start=integer(item.data_offsets[0],0,bytes.length),end=integer(item.data_offsets[1],start,bytes.length);
  const size=shape.reduce((a,b)=>a*b,1);
  if (end-start!==size*4||8+length+end>bytes.length) throw new Error('Invalid reranker head offsets');
  const result=Float32Array.from({length:size},(_,i)=>bytes.readFloatLE(8+length+start+i*4));
  if (!result.every(Number.isFinite)) throw new Error('Nonfinite reranker head weights');
  return result;
}
// Abramowitz/Stegun 7.1.26, absolute erf error below 1.5e-7.
function erf(x:number):number {
  const sign=x<0?-1:1,a=Math.abs(x),t=1/(1+.3275911*a);
  return sign*(1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-a*a));
}
export async function loadRerankerHead(directory:string):Promise<(cls:Float32Array)=>number> {
  const dense=await weight(directory,'2_Dense/model.safetensors','linear.weight',[768,768]);
  const normWeight=await weight(directory,'3_LayerNorm/model.safetensors','norm.weight',[768]);
  const normBias=await weight(directory,'3_LayerNorm/model.safetensors','norm.bias',[768]);
  const output=await weight(directory,'4_Dense/model.safetensors','linear.weight',[1,768]);
  const bias=await weight(directory,'4_Dense/model.safetensors','linear.bias',[1]);
  return cls=>{
    if (cls.length!==768||!cls.every(Number.isFinite)) throw new Error('Invalid reranker CLS output');
    const h=new Float64Array(768);
    for (let i=0;i<768;i++) {let value=0;for(let j=0;j<768;j++)value+=dense[i*768+j]*cls[j];h[i]=.5*value*(1+erf(value/Math.SQRT2));}
    const mean=h.reduce((a,b)=>a+b,0)/768,variance=h.reduce((a,b)=>a+(b-mean)**2,0)/768;
    let score=bias[0];
    for(let i=0;i<768;i++)score+=output[i]*((h[i]-mean)/Math.sqrt(variance+1e-5)*normWeight[i]+normBias[i]);
    if (!Number.isFinite(score)) throw new Error('Nonfinite reranker score');
    return score;
  };
}
export async function createCodeReranker(directory=rerankerDirectory()):Promise<CodeReranker> {
  await verifyReranker(directory);
  const t=await import('@huggingface/transformers');t.env.allowRemoteModels=false;
  const head=await loadRerankerHead(directory),tokenizer=await t.AutoTokenizer.from_pretrained(directory,{local_files_only:true});
  // dtype controls filename suffix here; the explicitly named artifact contains qint8 weights.
  const model=await t.AutoModel.from_pretrained(directory,{local_files_only:true,dtype:'fp32',model_file_name:'model_qint8_arm64',
    session_options:{intraOpNumThreads:1,interOpNumThreads:1,enableCpuMemArena:false}});
  let closed=false,closing:Promise<void>|undefined;
  return {
    score:async(query,documents)=>{
      if(closed)throw new Error('Reranker is closed');
      if(documents.length>8)throw new Error('Reranker candidate limit');
      const result:number[]=[];
      for(const document of documents){
        const inputs=tokenizer(query,{text_pair:document,padding:false,truncation:false});
        const tokens=inputs.input_ids?.dims.at(-1);
        if(tokens===undefined||tokens<1||tokens>1024)throw new Error('Reranker pair exceeds token limit');
        const output=await model(inputs),hidden=output.last_hidden_state;
        try{
          if(hidden.dims.length!==3||hidden.dims[0]!==1||hidden.dims[1]!==tokens||hidden.dims[2]!==768)throw new Error('Invalid reranker backbone output');
          result.push(head(hidden.data.slice(0,768)));
        }finally{hidden.dispose();}
      }
      if(closed)throw new Error('Reranker closed during inference');
      return result;
    },
    close:()=>{closed=true;return closing??=model.dispose();},
  };
}
