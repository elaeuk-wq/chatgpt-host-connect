#!/usr/bin/env python3
"""Portable host contracts; no installed services/accounts or production traffic."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SRC = Path(__file__).resolve().parents[1] / 'skills/chatgpt-host-connect/scripts'
sys.path.insert(0, str(SRC))
import host_runtime as rt
spec = importlib.util.spec_from_file_location('host', SRC / 'host.py')
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)


class Portability(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='host portable space ')
        self.root = Path(self.tmp.name).resolve() / '测试 host'
        self.root.mkdir()
    def tearDown(self):
        self.tmp.cleanup()
    def config(self):
        return dict(owner=h.OWNER, name='sample', root=str(self.root), manager='windows-task',
                    python_path=sys.executable, windows_sid='S-1-5-21-1-2-3-1000',
                    host_id='test-host', tunnel_id='tunnel_'+'a'*32, mcp_port=1, health_port=2)
    def test_managers_are_explicit(self):
        for os_name, manager in [('Darwin','launchd'),('Linux','systemd-user'),('Windows','windows-task')]:
            with patch.object(h.platform,'system',return_value=os_name):
                self.assertEqual(h.manager_for({}), manager)
        with patch.object(h.platform,'system',return_value='Windows'):
            with self.assertRaises(ValueError): h.manager_for({'manager':'systemd-user'})
    def test_windows_user_data_root(self):
        with patch.object(h.platform,'system',return_value='Windows'), patch.dict(os.environ,{'LOCALAPPDATA':str(self.root)}):
            self.assertEqual(h.root_for({'name':'sample'}),self.root.resolve()/'ChatGPTHost/sample')
    def test_task_has_no_password_or_elevation(self):
        c=self.config();xml=h.windows_task_xml(c,'mcp').decode()
        self.assertTrue(h.task_owned(xml,c))
        for text in ['InteractiveToken','LeastPrivilege','LogonTrigger','IgnoreNew','PT0S']:
            self.assertIn(text,xml)
        for text in ['<Password>','HighestAvailable','S-1-5-18','sk-']:
            self.assertNotIn(text,xml)
        self.assertIn('--serve mcp',xml)
    def test_foreign_task_refused(self):
        c=self.config();other={**c,'root':str(self.root/'other')}
        xml=h.windows_task_xml(other,'mcp').decode()
        with patch.object(h,'registered_windows_task',return_value=xml):
            with self.assertRaisesRegex(ValueError,'another installation'):h.check_service_owner(c)
    def test_windows_official_archives(self):
        for arch,asset_arch in [('AMD64','amd64'),('ARM64','arm64')]:
            root=self.root/arch;root.mkdir();buf=io.BytesIO()
            with zipfile.ZipFile(buf,'w') as z:z.writestr('tunnel-client-runtime.exe',b'fixture-only')
            data=buf.getvalue();asset='tunnel-client-runtime-'+h.VERSION+'-windows-'+asset_arch+'.zip'
            sums=(hashlib.sha256(data).hexdigest()+'  '+asset+'\n').encode()
            with patch.object(h.platform,'system',return_value='Windows'),patch.object(h.platform,'machine',return_value=arch),patch.object(h.urllib.request,'urlopen',side_effect=[io.BytesIO(sums),io.BytesIO(data)]):
                exe=h.client_binary(root)
                self.assertTrue(exe.endswith('.exe'));self.assertEqual(Path(exe).read_bytes(),b'fixture-only')
                self.assertEqual(h.client_binary(root),exe)
    def test_windows_install_uses_owned_tasks_and_bundled_sources(self):
        c=self.config();c['root']=str(self.root/'ChatGPTHost/sample')
        q=dict(name='sample',allow_control=True,tunnel_id=c['tunnel_id'],key='sk-'+'a'*30)
        def preflight(config,*a):config['windows_sid']=c['windows_sid']
        with patch.object(h.platform,'system',return_value='Windows'),patch.dict(os.environ,{'LOCALAPPDATA':str(self.root)}),patch.object(h,'manager_preflight',side_effect=preflight),patch.object(h,'registered_windows_task',return_value=''),patch.object(h,'stop'),patch.object(h,'client_binary',return_value=str(self.root/'tunnel.exe')),patch.object(h,'start_component') as start,patch.object(h,'wait_mcp'),patch.object(h,'status',return_value={'control_plane':'PENDING'}):
            result=h.install(q);self.assertTrue(result['installed']);self.assertEqual(start.call_count,2)
        root=Path(c['root'])
        for name in ['host.py','host-mcp.py','host_runtime.py','task-mcp.xml','task-tunnel.xml','runtime-key']:
            self.assertTrue((root/name).is_file(),name)
        self.assertFalse((root/'run-mcp.sh').exists())
        config=json.loads((root/'config.json').read_text())
        self.assertNotIn(q['key'],json.dumps(config))
        self.assertIn('file:'+str(root/'runtime-key'),config['tunnel_argv'])
    def test_windows_local_domain_and_entra_user_sid(self):
        for sid in ['S-1-5-21-1-2-3-1000','S-1-12-1-10-20-30-40']:
            responses=[subprocess.CompletedProcess([],0,sid+'\n',''),subprocess.CompletedProcess([],0,'','')]
            with patch.object(h,'powershell',side_effect=responses):
                c=self.config();h.manager_preflight(c);self.assertEqual(c['windows_sid'],sid)
        with patch.object(h,'powershell',return_value=subprocess.CompletedProcess([],0,'S-1-5-18\n','')):
            with self.assertRaises(ValueError):h.manager_preflight(self.config())

    def test_private_directory_and_file(self):
        rt.private_directory(self.root)
        key=self.root/'runtime-key';h.private_write(key,'synthetic-not-a-real-key')
        self.assertTrue(rt.private_file_ok(key))
    def test_output_and_timeout_real_child(self):
        r=rt.bounded_process([sys.executable,'-c','print("x"*20000)'],self.root,10,4096)
        self.assertEqual(r['exit_code'],0);self.assertTrue(r['truncated']);self.assertLessEqual(len(r['stdout']),4096)
        r=rt.bounded_process([sys.executable,'-c','import time; time.sleep(10)'],self.root,1,4096)
        self.assertTrue(r['timed_out'])
    def test_descendant_cannot_outlive_timeout(self):
        marker=self.root/'escaped.txt'
        child='import time,pathlib;time.sleep(3);pathlib.Path('+repr(str(marker))+').write_text("escaped")'
        code='import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",'+repr(child)+']);time.sleep(10)'
        r=rt.bounded_process([sys.executable,'-c',code],self.root,1,4096)
        self.assertTrue(r['timed_out'])
        import time;time.sleep(3)
        self.assertFalse(marker.exists())
    def test_packaged_files_use_no_developer_machine(self):
        forbidden=['/Users/xujun','/home/bot','192.168.2.27','127.0.0.1:9333','127.0.0.1:19222']
        for p in SRC.parent.rglob('*'):
            if p.is_file() and p.suffix in ['.py','.mjs','.sh','.ps1','.md']:
                for value in forbidden:self.assertNotIn(value,p.read_text(encoding='utf-8'),str(p))
    def test_windows_bootstrap_has_no_secret_or_policy_bypass(self):
        s=(SRC/'bootstrap.ps1').read_text()
        self.assertIn('--scope user',s);self.assertIn('--disable-interactivity',s)
        self.assertNotIn('ExecutionPolicy Bypass',s)
        self.assertNotIn('sk-',s)
    @unittest.skipUnless(os.name=='nt','native Windows only; CI runs on Windows')
    def test_windows_task_xml_validate_without_registering(self):
        # Task Scheduler validates the XML in memory; never registers/starts a task.
        xml=h.windows_task_xml(self.config(),'mcp').decode()
        code="$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $d=$s.NewTask(0); $d.XmlText="+rt.ps_quote(xml)
        result=rt.powershell(code)
        self.assertEqual(result.returncode,0,result.stderr)


if __name__=='__main__':unittest.main(verbosity=2)
