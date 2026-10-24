// No browser/account/services: path discovery, stdin transports and shell contracts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {acceptanceCommand, bindTarget, transport} from '../../skills/chatgpt-host-connect/scripts/browser/host-client.mjs';
import {browserProfileRoots, discoverEndpoints, connect} from '../../skills/chatgpt-host-connect/scripts/browser/cdp.mjs';
import {privateDir, privateFileOk, powershellPath, psArgs} from '../../skills/chatgpt-host-connect/scripts/browser/platform.mjs';
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'host portability space ')));
let passed=0;
function check(name, fn) { fn();passed++;console.log('PASS '+name); }
let server;
const pendingSockets=new Set();
try {
  check('profiles derive from OS home/XDG/LocalAppData',()=>{
    assert(browserProfileRoots('darwin','/example/user',{}).every(p=>p.startsWith('/example/user/')));
    assert(browserProfileRoots('linux','/example/user',{XDG_CONFIG_HOME:'/var/config space'}).every(p=>p.startsWith('/var/config space/')));
    assert(browserProfileRoots('win32','C:\\Users\\test',{LOCALAPPDATA:'D:\\profile space'}).every(p=>p.startsWith('D:\\profile space\\')));
  });
  server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({webSocketDebuggerUrl:`ws://127.0.0.1:${server.address().port}/devtools/browser/fixture`}));});
  server.on('upgrade',(_req,socket)=>{pendingSockets.add(socket);socket.on('close',()=>pendingSockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  for(const name of ['profile A','profile B','stale']) {
    fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,'DevToolsActivePort'),`${server.address().port}\n/devtools/browser/${name==='stale'?'stale':'fixture'}\n`);
  }
  check('explicit custom profile has no fixed-port dependency',()=>{});
  assert.equal((await discoverEndpoints({profile:path.join(root,'profile A')}))[0].endpoint,endpoint);
  assert.equal((await discoverEndpoints({profile:path.join(root,'stale')})).length,0);
  check('stale discovery metadata does not select another browser',()=>{});
  assert.equal((await discoverEndpoints({roots:['profile A','profile B'].map(p=>path.join(root,p))})).length,2);
  check('discovery returns all candidates rather than silently picking first',()=>{});
  await assert.rejects(connect(endpoint,{timeout:100}),/timed out waiting/);
  check('Windows/direct browser connection is bounded, not an indefinite wait',()=>{});
  for(const socket of pendingSockets)socket.destroy();
  const target={alias:'test-host',name:'sample',manager:'auto',os:'posix'};
  const request={bootstrap_source:'prepare_python() { HOST_SETUP_PYTHON=python3; }',key:'synthetic-secret'};
  const posix=transport(target,request,{},'install');
  const win=transport({...target,os:'windows'},request,{},'install');
  check('SSH transport preserves strict host keys and excludes credentials from argv',()=>{
    for(const t of [posix,win]) {
      assert.equal(t[0],'ssh');assert(t[1].includes('StrictHostKeyChecking=yes'));
      assert(!JSON.stringify(t).includes(request.key));
    }
    assert(posix[1].at(-1).includes('json.load(sys.stdin)'));
    assert(!win[1].at(-1).includes('/bin/bash'));
    assert(win[1].at(-1).length<7000,'Windows OpenSSH command must fit cmd.exe');
    assert(request.windows_bootstrap_source.includes('Prepare-HostPython'));
  });
  check('state refuses a changed target OS',()=>{
    const s={target};assert.throws(()=>bindTarget(s,{'target-os':'windows'}),/another target OS/);
  });
  const token='hcs-0123456789abcdef'; // gitleaks:allow -- synthetic acceptance marker, not a credential
  const outputs={root:path.join(root,'验收 directory'),host_id:'fixture-host',python_path:process.env.HOST_SETUP_TEST_PYTHON|| (process.platform==='win32'?'python':'python3'),os:process.platform==='win32'?'Windows':'Linux'};
  fs.mkdirSync(outputs.root);
  const command=acceptanceCommand(outputs,token);
  const launch=process.platform==='win32'?[powershellPath(),psArgs(command)]:['/bin/bash',['-c',command]];
  const result=spawnSync(...launch,{env:{...process.env,MCP_HOST_ID:outputs.host_id,PYTHONUTF8:'1'},encoding:'utf8',timeout:20000});
  check('real acceptance works with spaces/Unicode and writes exact LF marker',()=>{
    assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(path.join(outputs.root,'acceptance',token+'.txt'),'utf8'),token+'\n');
  });
  check('Windows acceptance is PowerShell, not bash quoting or cmd expansion',()=>{
    const c=acceptanceCommand({root:'D:\\user space\\测试',host_id:'fixture-host',python_path:"C:\\O'Brien\\python.exe",os:'Windows'},token);
    assert(c.startsWith("& 'C:\\O''Brien"));assert(c.endsWith('; exit $LASTEXITCODE'));
    assert(!c.includes('/bin/bash'));assert(c.includes('b64decode'));
  });
  const privatePath=path.join(root,'private');privateDir(privatePath);
  const file=path.join(privatePath,'key.txt');fs.writeFileSync(file,'synthetic',{mode:0o600});
  check('private state uses real OS permissions',()=>assert(privateFileOk(file)));
  check('source paths are independent of current working directory',()=>{
    const [exe,args]=transport({...target,alias:'local'},request,{},'status');
    assert(args.at(-1).includes('host.py'));assert.equal(exe,'/bin/bash');
  });
  const winScript=Buffer.from(win[1].at(-1).split(' ').at(-1),'base64').toString('utf16le');
  check('Windows stdin is read before dependency installation; no policy bypass',()=>{
    assert(winScript.indexOf('ReadToEnd')<winScript.lastIndexOf('Prepare-HostPython'));
    assert(!/ExecutionPolicy.*Bypass/.test(winScript));assert(winScript.includes('json.load(sys.stdin)'));
  });
  console.log(`result: ${passed} portability checks passed`);
} finally {
  for(const socket of pendingSockets)socket.destroy();
  if(server)await new Promise(resolve=>server.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});
}
