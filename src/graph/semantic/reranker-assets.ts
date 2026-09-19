import path from 'node:path';
import { LOCAL_MODEL_DIR } from '../../embeddings.js';
export const RERANKER_ID = 'cross-encoder/ettin-reranker-150m-v1';
export const RERANKER_REVISION = '025501c4e0f9bbeb4c5b198318e0089ff061cc14';
export const rerankerDirectory = (): string => path.join(LOCAL_MODEL_DIR(),RERANKER_ID,RERANKER_REVISION);
export const RERANKER_FILES: readonly {file:string;bytes:number;sha256:string}[] = [
  {
    "file": "config.json",
    "bytes": 2020,
    "sha256": "7edec5dedd402976edd3b66abeb432377ecd04c27a5e974b2601160c3519c0f9"
  },
  {
    "file": "tokenizer.json",
    "bytes": 3583327,
    "sha256": "28c5e078e4c52aa37cf0e6de1a212878f3dbd58dd1c70466298efe0b6b86db35"
  },
  {
    "file": "tokenizer_config.json",
    "bytes": 488,
    "sha256": "2b85302525d8c528a9e1fbaea2733472bd00d4755eae881441c8c52b90e2d600"
  },
  {
    "file": "modules.json",
    "bytes": 678,
    "sha256": "d8394ab6c24cb0fb80229dafb886fac022ff489e757e3e6ed7d69603d5ae5942"
  },
  {
    "file": "sentence_bert_config.json",
    "bytes": 241,
    "sha256": "3084164002c0bca01b0259c5327123803fce32e660a57feb93184ffead186fc8"
  },
  {
    "file": "1_Pooling/config.json",
    "bytes": 89,
    "sha256": "b7703fedc62cbe2d1e4fd47338d5ba9ee5b2107d49fc42e85ae848484fdd08bc"
  },
  {
    "file": "2_Dense/config.json",
    "bytes": 228,
    "sha256": "20e26ecba6c2f764ebdab2746b2a24ff10b0b796f67d9785775081e1bc418986"
  },
  {
    "file": "2_Dense/model.safetensors",
    "bytes": 2359384,
    "sha256": "bc39a6bdfd371a47a08fbf84781bc7224b846ec0e15213b560d2abbbfb323b75"
  },
  {
    "file": "3_LayerNorm/config.json",
    "bytes": 24,
    "sha256": "b6d7814b096e2c4d22d40b0e28a039411c77996af17897e2b4778dad36fc530c"
  },
  {
    "file": "3_LayerNorm/model.safetensors",
    "bytes": 6296,
    "sha256": "a119c63bd3b89934c89f2394e2278014e663e01625dc322c603ddbf24b10325c"
  },
  {
    "file": "4_Dense/config.json",
    "bytes": 213,
    "sha256": "31c0988ed5597ae65208c0783a84b944577bfaf597bd8f1ecc82945ea31e9d54"
  },
  {
    "file": "4_Dense/model.safetensors",
    "bytes": 3220,
    "sha256": "cececab2925f12c9c7541d5d438202a6eec4b503658e0e64790f2d0414ede6a8"
  },
  {
    "file": "onnx/model_qint8_arm64.onnx",
    "bytes": 150628482,
    "sha256": "27ac73363fd16d308fd7f91044df323f53af390ef775ac51e56e551c1adcee7d"
  }
];
