// Narrow ambient surface for the OPTIONAL dependency (plan 14 / review B1):
// tsc resolves dynamic import specifiers at compile time, so without this
// declaration a public clone whose optional dep failed to install cannot
// build. Declares ONLY the members embeddings.ts uses — honest types, no
// escape hatches. Verified (scratch repro 2026-08-09) to compile both with
// the package absent AND with it present shipping its own types.
// LOAD-BEARING CAVEAT (pass-3 N6): this declaration SHADOWS the real package's
// types even when installed — tsc never checks against the actual API. The
// gated MAI_TEST_LOCAL_EMBED=1 run is the only real-API check: run it before
// calling plan 14 done, and re-run it on any @huggingface/transformers bump.
declare module "@huggingface/transformers" {
  export const env: { cacheDir: string; allowRemoteModels: boolean };
  export interface FeatureExtractionOutput { data: Float32Array }
  export interface FeatureExtractionPipeline {
    (text: string, opts: { pooling: "mean"; normalize: boolean }): Promise<FeatureExtractionOutput>;
    dispose(): Promise<void>;
    tokenizer: { encode(text: string): number[] };
  }
  export interface TokenTensor { data: BigInt64Array; dims: number[] }
  export interface PairTokenizer {
    (text: string, options: {text_pair:string;padding:false;truncation:false}): Record<string,TokenTensor>;
    encode(text: string): number[];
  }
  export interface EncoderOutput { last_hidden_state: {data:Float32Array;dims:number[];dispose():void} }
  export interface EncoderModel {
    (inputs: Record<string,TokenTensor>): Promise<EncoderOutput>;
    dispose(): Promise<void>;
  }
  export const AutoTokenizer: {from_pretrained(directory:string,options:{local_files_only:true}):Promise<PairTokenizer>};
  export const AutoModel: {from_pretrained(directory:string,options:{local_files_only:true;dtype:'fp32';model_file_name:string;
    session_options:{intraOpNumThreads:1;interOpNumThreads:1;enableCpuMemArena?:false}}):Promise<EncoderModel>};
  export function pipeline(
    task: "feature-extraction",
    model: string,
    opts?: { dtype?: string; local_files_only?: boolean;
      session_options?: { intraOpNumThreads?: number; interOpNumThreads?: number } }
  ): Promise<FeatureExtractionPipeline>;
}
