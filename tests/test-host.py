#!/usr/bin/env python3
"""Host lifecycle with real local children and mocked OS service manager calls.
No installed LaunchAgents, systemd changes, SSH, paid API calls or real keys.
"""
import hashlib
import io
import shlex
import zipfile
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/'skills/chatgpt-host-connect/scripts'
sys.path.insert(0,str(SRC))
spec=importlib.util.spec_from_file_location('host',SRC/'host.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
MOCK=ROOT/'tests/mock-tunnel-client'

class HostTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='host-install-test-')
        self.home=Path(self.tmp.name)
        self.patch=patch.object(Path,'home',return_value=self.home);self.patch.start()
        self.children=[]
    def tearDown(self):
        self.stop_children()
        self.patch.stop();self.tmp.cleanup()
    def stop_children(self,*a):
        for p in self.children:
            if p.poll() is None:p.terminate()
            p.wait(timeout=8)
        self.children=[]
    def start(self,c,component):
        root=Path(c['root'])
        with (root/(component+'.log')).open('ab') as f:
            self.children.append(subprocess.Popen([str(root/('run-'+component+'.sh'))],stdout=f,stderr=f))
    def config(self,manager='launchd'):
        return dict(owner=h.OWNER,name='test',root=str(h.root_for({'name':'test'})),manager=manager,tunnel_id='tunnel_'+'a'*32,host_id='test-host',mcp_port=11111,health_port=11112)
    def test_input_validation(self):
        for name in ['../escape','A','--bad','', 'a'*41]:
            with self.assertRaises(ValueError):h.root_for({'name':name})
        with self.assertRaises(ValueError):h.read_key('not-a-key')
        with self.assertRaises(ValueError):h.install({'name':'test'})
        self.assertEqual(h.read_key('CONTROL_PLANE_API_KEY=sk-'+'a'*30),'sk-'+'a'*30)
    def test_owner_refusal(self):
        root=h.root_for({'name':'test'});root.mkdir(parents=True)
        with self.assertRaises(ValueError):h.owned_config(root)
        h.private_write(root/'config.json',json.dumps({'owner':'someone-else'}))
        with self.assertRaises(ValueError):h.owned_config(root)
        c=self.config();_,p=h.paths(c,'mcp');p.parent.mkdir(parents=True);p.write_text('foreign')
        with self.assertRaises(Exception):h.check_service_owner(c)
    def test_service_renderers(self):
        c=self.config();data=plistlib.loads(h.service_text(c,'mcp',[]))
        self.assertTrue(data['KeepAlive']);self.assertEqual(data['ChatGPTHostOwner'],c['root'])
        c=self.config('systemd-user');txt=h.service_text(c,'tunnel',[]).decode()
        self.assertIn('WantedBy=default.target',txt);self.assertIn('Restart=on-failure',txt)
        self.assertNotIn('sk-',txt);self.assertNotIn('User=root',txt)
    def test_secret_mode_and_symlinks(self):
        p=self.home/'secret';h.private_write(p,'fake')
        self.assertEqual(p.stat().st_mode&0o777,0o600)
        q=self.home/'link';q.symlink_to(p)
        with self.assertRaises(ValueError):h.private_write(q,'other')
    def test_linger_requires_authorization(self):
        calls=[]
        def run(argv,**kwargs):
            calls.append(argv)
            value='tester\n' if argv[0]=='id' else 'no\n' if argv[0]=='loginctl' else ''
            return subprocess.CompletedProcess(argv,0,value,'')
        with patch.object(os,'getuid',return_value=501),patch.object(h,'run',side_effect=run):
            with self.assertRaises(ValueError):h.manager_preflight(self.config('systemd-user'))
            self.assertFalse(any(a[0]=='sudo' for a in calls))
            h.manager_preflight(self.config('systemd-user'),True)
            self.assertTrue(any(a[:4]==['sudo','-n','loginctl','enable-linger'] for a in calls))
    def test_stale_metrics(self):
        c=self.config()
        with patch.object(h,'http',side_effect=[json.dumps({'host_id':'test-host','control':True}),'commands_poll_last_successful_timestamp_seconds 1']):
            self.assertEqual(h.status(c)['control_plane'],'PENDING')
    def test_install_reinstall_status_and_evidence(self):
        key='sk-good-'+'a'*30
        q=dict(name='test',tunnel_id='tunnel_'+'a'*32,key=key,manager='launchd',allow_control=True,control_plane_proxy='http://proxy.example:18080',probe_source=(SRC/'host-mcp.py').read_text())
        with patch.object(h.platform,'system',return_value='Darwin'),patch.object(h,'manager_preflight'),patch.object(h,'client_binary',return_value=str(MOCK)),patch.object(h,'stop',side_effect=self.stop_children),patch.object(h,'start_component',side_effect=self.start):
            try:
                result=h.install(q)
            except Exception:
                log=h.root_for(q)/'mcp.log'
                if log.exists(): print('Isolated MCP startup log:',log.read_text(errors='replace')[-3000:])
                raise
            self.assertTrue(result['installed'])
            root=h.root_for(q);c=h.owned_config(root)
            for _ in range(30):
                if h.status(c)['control_plane']=='OK':break
                time.sleep(0.1)
            self.assertEqual(h.status(c)['control_plane'],'OK')
            self.assertEqual((root/'runtime-key').stat().st_mode&0o777,0o600)
            self.assertEqual(root.stat().st_mode&0o777,0o700)
            for component in ['mcp','tunnel']:
                self.assertNotIn(key,(root/('run-'+component+'.sh')).read_text())
            tokens=['hcs-0123456789abcdef','hcs-fedcba9876543210']
            op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for t in tokens:
                req=urllib.request.Request('http://127.0.0.1:%s/mcp'%c['mcp_port'],data=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'host_probe','arguments':{'echo_token':t}}}).encode(),headers={'Content-Type':'application/json'})
                with op.open(req,timeout=5) as r:self.assertEqual(r.status,200)
            self.assertTrue(h.logs(c,tokens)['verified'])
            self.assertFalse(h.logs(c,[tokens[0],'hcs-0000000000000000'])['verified'])
            # One real execute_terminal call checks identity + write/read together.
            token='hcs-1111222233334444'
            adapter=(SRC/'browser/host-client.mjs').as_uri()
            js='import {acceptanceCommand} from '+json.dumps(adapter)+'; process.stdout.write(acceptanceCommand(JSON.parse(process.argv[1]),process.argv[2]));'
            command=subprocess.check_output(['node','--input-type=module','-e',js,json.dumps({'root':c['root'],'host_id':c['host_id'],'python_path':sys.executable}),token],text=True)
            digest=hashlib.sha256(command.encode()).hexdigest()
            self.assertFalse(h.verify_acceptance(c,token,digest)['verified'])
            req=urllib.request.Request('http://127.0.0.1:%s/mcp'%c['mcp_port'],data=json.dumps({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'execute_terminal','arguments':{'command':command,'timeout':20}}}).encode(),headers={'Content-Type':'application/json'})
            with op.open(req,timeout=5) as r:
                result=json.load(r)['result'];self.assertFalse(result['isError'])
                self.assertEqual(json.loads(result['content'][0]['text'])['exit_code'],0)
            proof=h.verify_acceptance(c,token,digest)
            self.assertTrue(proof['verified']);self.assertTrue(proof['file_ok']);self.assertTrue(proof['shell_ok'])
            self.assertFalse(h.verify_acceptance(c,token,'0'*64)['verified'])
            (root/'acceptance'/(token+'.txt')).write_text('wrong marker')
            self.assertFalse(h.verify_acceptance(c,token,digest)['verified'])
            self.assertIn('--control-plane.http-proxy http://proxy.example:18080',(root/'run-tunnel.sh').read_text())
            self.assertNotIn('proxy.example',(root/'run-mcp.sh').read_text())
            old_id=c['host_id'];q['key']='sk-good-'+'b'*30
            del q['control_plane_proxy']
            result=h.install(q)
            self.assertEqual(result['host_id'],old_id);self.assertEqual(len(self.children),2)
            self.assertEqual(h.owned_config(root)['control_plane_proxy'],'http://proxy.example:18080')
            self.assertEqual(h.owned_config(root)['client_bin'],str(MOCK))
            self.assertEqual((root/'runtime-key').read_text().strip(),q['key'])
            with self.assertRaises(ValueError):h.install({**q,'tunnel_id':'tunnel_'+'b'*32})
            self.assertNotIn(q['key'],(root/'tunnel.log').read_text())
    def test_proxy_is_target_discovered_or_explicit(self):
        with patch.object(h.urllib.request,'getproxies',return_value={'https':'http://target-proxy.example:18081'}):
            self.assertEqual(h.control_plane_proxy({},{}),'http://target-proxy.example:18081')
            self.assertIsNone(h.control_plane_proxy({'control_plane_proxy':'direct'},{}))
            self.assertEqual(h.control_plane_proxy({}, {'control_plane_proxy':'http://saved.example:18082'}),'http://saved.example:18082')
            self.assertEqual(h.control_plane_proxy({'control_plane_proxy':'auto'}, {'control_plane_proxy':'http://saved.example:18082'}),'http://target-proxy.example:18081')
        with patch.object(h.urllib.request,'getproxies',return_value={}):
            self.assertIsNone(h.control_plane_proxy({},{}))
        for proxy in ['http://user:password@proxy.example:80','http://proxy.example?secret=x','file:///tmp/x','http://proxy.example:99999']:
            with self.assertRaises(ValueError):h.control_plane_proxy({'control_plane_proxy':proxy},{})
    def test_cold_mac_installs_official_formula_without_old_client(self):
        prefix=self.home/'brew';client=prefix/'opt/tunnel-client/bin/tunnel-client'
        calls=[]
        def run(argv,**kw):
            calls.append(argv)
            out=''
            if argv[0]=='/bin/bash':out=str(prefix/'bin/brew')
            elif argv[-1]=='--prefix':out=str(prefix)
            elif 'install' in argv:
                self.assertEqual(argv[1:],['install','openai/tools/tunnel-client'])
                self.assertEqual(kw['env']['HOMEBREW_NO_INSTALL_CLEANUP'],'1')
                client.parent.mkdir(parents=True);client.write_text('#!/bin/sh\nexit 0\n');client.chmod(0o700)
            return subprocess.CompletedProcess(argv,0,out,'')
        with patch.object(h.platform,'system',return_value='Darwin'),patch.object(h,'run',side_effect=run),patch.object(h.shutil,'which',side_effect=AssertionError('No old client PATH lookup')):
            self.assertEqual(h.client_binary(self.home),str(client))
            self.assertEqual(h.client_binary(self.home),str(client))
        self.assertEqual(sum('install' in a for a in calls),1)
        self.assertEqual(sum(a[-1]=='--version' for a in calls),2)

    def test_cold_linux_downloads_verified_architecture(self):
        for arch,suffix in [('x86_64','amd64'),('aarch64','arm64')]:
            root=self.home/arch;root.mkdir()
            buf=io.BytesIO()
            with zipfile.ZipFile(buf,'w') as z:z.writestr('tunnel-client-runtime',b'fixture executable')
            archive=buf.getvalue();asset='tunnel-client-runtime-'+h.VERSION+'-linux-'+suffix+'.zip'
            sums=(hashlib.sha256(archive).hexdigest()+'  '+asset+'\n').encode()
            with patch.object(h.platform,'system',return_value='Linux'),patch.object(h.platform,'machine',return_value=arch),patch.object(h.urllib.request,'urlopen',side_effect=[io.BytesIO(sums),io.BytesIO(archive)]) as download:
                client=h.client_binary(root)
                self.assertEqual(Path(client).read_bytes(),b'fixture executable')
                self.assertTrue(os.access(client,os.X_OK))
                self.assertTrue(download.call_args_list[1].args[0].endswith(asset))
                self.assertEqual(h.client_binary(root),client)
                self.assertEqual(download.call_count,2)

    def test_pending_install_is_not_an_installation_failure(self):
        c=self.config();root=Path(c['root'])
        q=dict(name='test',tunnel_id=c['tunnel_id'],key='sk-'+'a'*30,allow_control=True,manager='launchd')
        with patch.object(h.platform,'system',return_value='Darwin'),patch.object(h,'manager_preflight'),patch.object(h,'client_binary',return_value=str(MOCK)),patch.object(h,'stop'),patch.object(h,'start_component') as start,patch.object(h,'wait_mcp'),patch.object(h,'status',return_value={'control_plane':'PENDING','host_id':'new-host','mcp_ok':True}):
            r=h.install(q)
            self.assertTrue(r['installed']);self.assertEqual(r['control_plane'],'PENDING')
            self.assertEqual(start.call_count,2);self.assertTrue((root/'config.json').exists())

    def test_bootstrap_missing_brew_requires_real_admin_approval(self):
        script=(SRC/'bootstrap.sh').read_text()+'''\nfind_brew() { HOST_SETUP_BREW=''; }
 id() { echo 501; }
 sudo() { return 1; }
 curl() { echo SHOULD_NOT_FETCH; exit 99; }
 ensure_brew
'''
        r=subprocess.run(['/bin/bash','-c',script],capture_output=True,text=True,input='PRIVATE_REQUEST')
        self.assertEqual(r.returncode,1)
        self.assertIn('administrator approval',json.loads(r.stdout)['error'])
        self.assertNotIn('SHOULD_NOT_FETCH',r.stdout+r.stderr)
        self.assertNotIn('PRIVATE_REQUEST',r.stdout+r.stderr)

    def test_bootstrap_new_homebrew_uses_official_installer(self):
        marker=self.home/'brew-installed'
        script=(SRC/'bootstrap.sh').read_text()+'\n'+f'''
find_brew() {{ HOST_SETUP_BREW=''; if [ -f {shlex.quote(str(marker))} ]; then HOST_SETUP_BREW=/fixture/brew; fi; }}
id() {{ echo 501; }}
sudo() {{ [ "$*" = '-n -v' ]; }}
curl() {{
 case "$*" in *https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh*) ;; *) exit 99 ;; esac
 printf '%s\\n' {shlex.quote('touch '+shlex.quote(str(marker)))}
}}
ensure_brew
printf '%s' "$HOST_SETUP_BREW"
'''
        r=subprocess.run(['/bin/bash','-c',script],capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stdout,'/fixture/brew')
        self.assertTrue(marker.exists())

    def test_bootstrap_linux_package_managers(self):
        for manager in ['apt-get','dnf']:
            marker=self.home/(manager+'-python');record=self.home/(manager+'-calls')
            script=(SRC/'bootstrap.sh').read_text()+'\n'+f'''
find_python() {{ HOST_SETUP_PYTHON=''; if [ -f {shlex.quote(str(marker))} ]; then HOST_SETUP_PYTHON={shlex.quote(sys.executable)}; fi; }}
uname() {{ echo Linux; }}
id() {{ echo 1000; }}
command() {{ [ "$1" = -v ] && [ "$2" = {manager} ]; }}
sudo() {{ printf '%s\\n' "$*" >> {shlex.quote(str(record))}; case "$*" in *install*) touch {shlex.quote(str(marker))} ;; esac; return 0; }}
prepare_python
exec "$HOST_SETUP_PYTHON" -c 'import sys; assert sys.stdin.read()=="private-input"; print("preserved")'
'''
            r=subprocess.run(['/bin/bash','-c',script],input='private-input',capture_output=True,text=True)
            self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stdout.strip(),'preserved')
            calls=record.read_text();self.assertIn('python3 ca-certificates',calls)
            self.assertIn(manager+' install',calls)

    def test_bootstrap_python_preserves_request_stdin(self):
        # Simulate a pristine Mac; fake brew alone installs the interpreter.
        prefix=self.home/'python';(prefix/'bin').mkdir(parents=True)
        interpreter=prefix/'bin/python3.13'
        interpreter.write_text('#!/bin/bash\nexec '+shlex.quote(sys.executable)+' "$@"\n');interpreter.chmod(0o700)
        brew=self.home/'fake-brew';record=self.home/'calls'
        brew.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> '+shlex.quote(str(record))+'\nif [ "$1" = --prefix ]; then echo '+shlex.quote(str(prefix))+'; fi\n');brew.chmod(0o700)
        script=(SRC/'bootstrap.sh').read_text()+'\nfind_python() { HOST_SETUP_PYTHON=""; }\nid() { echo 501; }\nuname() { echo Darwin; }\nensure_brew() { HOST_SETUP_BREW='+shlex.quote(str(brew))+'; }\nprepare_python\nexec "$HOST_SETUP_PYTHON" -c '+shlex.quote('import json,sys; assert json.load(sys.stdin)=={"private":"untouched"}; print("preserved")')
        r=subprocess.run(['/bin/bash','-c',script],input='{"private":"untouched"}',capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stdout.strip(),'preserved')
        self.assertEqual(record.read_text().splitlines(),['install python@3.13','--prefix python@3.13'])

    def test_checksum_rejects_modified_existing_binary(self):
        root=self.home/'bin';root.mkdir();p=root/('tunnel-client-'+h.VERSION);p.write_bytes(b'bad')
        (root/'client.sha256').write_text(hashlib.sha256(b'good').hexdigest())
        with patch.object(h.platform,'system',return_value='Linux'),patch.object(h.platform,'machine',return_value='aarch64'):
            with self.assertRaisesRegex(ValueError,'checksum mismatch'):h.client_binary(root)

if __name__=='__main__':unittest.main(verbosity=2)
