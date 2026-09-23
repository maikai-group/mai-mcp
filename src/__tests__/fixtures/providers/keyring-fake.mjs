let input='';
for await (const chunk of process.stdin) input += chunk;
const mode=process.argv[2];
const success=()=>process.stdout.write(JSON.stringify({ok:true,master:Buffer.alloc(32,7).toString('base64')}));
if (mode==='read-valid') success();
else if (mode==='absent') process.stdout.write('{"ok":true,"master":null}');
else if (mode==='malformed') process.stdout.write('{"ok":true,"master":"not base64"}');
else if (mode==='oversized') process.stdout.write('x'.repeat(5000));
else if (mode==='stderr-secret') { process.stderr.write('synthetic-secret'); process.stdout.write('{"ok":false,"error":"store_unavailable"}'); }
else if (mode==='hang') setInterval(()=>{},1000);
else if (mode==='env') {
  if (Object.keys(process.env).some(k=>/API_KEY|TOKEN|NODE_OPTIONS|MAI_/.test(k))) process.exitCode=1;
  else success();
} else process.exitCode=1;
