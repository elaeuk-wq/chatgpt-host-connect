// Only used with loopback fixture sites; never installs a service.
let raw='';for await (const chunk of process.stdin) raw+=chunk;
const request=JSON.parse(raw);
const response=await fetch(process.env.HOST_SETUP_FIXTURE+'/api/host',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
const result = await response.json();
console.log(JSON.stringify(result));
process.exitCode = !result.ok ? 1 : request.action === 'status' && result.control_plane === 'PENDING' ? 2 : 0;
