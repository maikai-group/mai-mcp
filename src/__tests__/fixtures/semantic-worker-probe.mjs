import { acquireLease, terminateInference } from '../../../build/graph/semantic/runtime.js';
const lease=await acquireLease(terminateInference);
process.stdout.write(lease?'acquired\n':'busy\n');
if(lease)setInterval(()=>{},1000);
