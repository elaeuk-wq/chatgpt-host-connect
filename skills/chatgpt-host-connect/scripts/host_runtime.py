"""Shared runtime primitives; standard library only, no machine-specific paths."""
import base64
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import signal
import subprocess
import threading
import time


def powershell(script, timeout=30):
    exe = str(Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
    return subprocess.run([exe, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                           base64.b64encode(script.encode('utf-16le')).decode()],
                          capture_output=True, text=True, encoding='utf-8', timeout=timeout)


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def private_directory(path):
    p = Path(path)
    if p.is_symlink() or any(x.is_symlink() for x in p.parents):
        raise ValueError('Private directory must not contain symlinks')
    p.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != 'nt':
        p.chmod(0o700)
        return
    # chmod(0600) is NOT a Windows DACL. Protect before writing any credential.
    script = "$ErrorActionPreference='Stop'; $p=" + ps_quote(p) + """
if ((Get-Item -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
  $who=New-Object Security.Principal.SecurityIdentifier($id)
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $p -AclObject $acl
"""
    if powershell(script).returncode:
        raise RuntimeError('Cannot protect the installation directory with a private Windows ACL')


def private_file_ok(path):
    p = Path(path)
    if p.is_symlink() or not p.is_file():
        return False
    if os.name != 'nt':
        return not p.stat().st_mode & 0o077
    script = "$ErrorActionPreference='Stop'; $p=" + ps_quote(p) + """
$allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
$acl=Get-Acl -LiteralPath $p
foreach($r in $acl.Access) {
  $sid=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($r.AccessControlType -eq 'Allow' -and $sid -notin $allowed) { exit 2 }
}
"""
    return powershell(script).returncode == 0


class WindowsJob:
    """Kill the whole child tree on timeout or service termination, not just its shell.

    Assign a suspended process before resuming it: a fast child must not escape
    the job between Popen and AssignProcessToJobObject. No breakaway privilege.
    """
    def __init__(self):
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        self.k = k
        self.handle = k.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError('Cannot create Windows process job')
        class BASIC(ctypes.Structure):
            _fields_ = [('ProcessTime', ctypes.c_int64), ('JobTime', ctypes.c_int64), ('Flags', wintypes.DWORD),
                        ('MinWorking', ctypes.c_size_t), ('MaxWorking', ctypes.c_size_t), ('Active', wintypes.DWORD),
                        ('Affinity', ctypes.c_size_t), ('Priority', wintypes.DWORD), ('Scheduling', wintypes.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ['ReadOps','WriteOps','OtherOps','ReadBytes','WriteBytes','OtherBytes']]
        class EXTENDED(ctypes.Structure):
            _fields_ = [('Basic', BASIC), ('Io', IO), ('ProcessMemory', ctypes.c_size_t), ('JobMemory', ctypes.c_size_t),
                        ('PeakProcess', ctypes.c_size_t), ('PeakJob', ctypes.c_size_t)]
        info = EXTENDED(); info.Basic.Flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            self.close(); raise OSError('Cannot configure Windows process job')

    def attach_and_resume(self, process):
        if not self.k.AssignProcessToJobObject(self.handle, wintypes.HANDLE(int(process._handle))):
            process.kill(); process.wait()
            raise OSError('Cannot contain child process in a Windows job')
        n = ctypes.WinDLL('ntdll')
        n.NtResumeProcess.argtypes = [wintypes.HANDLE]
        n.NtResumeProcess.restype = ctypes.c_long
        if n.NtResumeProcess(wintypes.HANDLE(int(process._handle))) != 0:
            self.close(); process.wait()
            raise OSError('Cannot resume contained Windows process')

    def close(self):
        if self.handle:
            self.k.CloseHandle(self.handle); self.handle = None


def bounded_process(argv, cwd, timeout, limit, env=None):
    job = WindowsJob() if os.name == 'nt' else None
    p = None
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    counts = {'stdout': 0, 'stderr': 0}
    threads = []
    timed_out = False
    deadline = time.monotonic() + timeout
    try:
        flags = 0x4 | 0x08000000 if job else 0  # CREATE_SUSPENDED | CREATE_NO_WINDOW
        p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=not bool(job), creationflags=flags)
        if job:
            job.attach_and_resume(p)
        def drain(stream, label):
            try:
                while True:
                    chunk = os.read(stream.fileno(), 65536)
                    if not chunk:
                        break
                    counts[label] += len(chunk)
                    buffers[label].extend(chunk[:max(0, limit - len(buffers[label]))])
            finally:
                stream.close()
        for stream, label in [(p.stdout, 'stdout'), (p.stderr, 'stderr')]:
            t = threading.Thread(target=drain, args=(stream, label), daemon=True)
            t.start(); threads.append(t)
        while p.poll() is None or any(t.is_alive() for t in threads):
            if time.monotonic() >= deadline:
                timed_out = True; break
            time.sleep(0.02)
    finally:
        if job:
            job.close()
        elif p:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if p:
            p.wait(timeout=5)
        for t in threads:
            t.join(timeout=5)
    return {'exit_code': p.returncode, 'timed_out': timed_out,
            'truncated': sum(counts.values()) > sum(map(len, buffers.values())),
            **{k: v.decode('utf-8', errors='replace') for k, v in buffers.items()}}


def shell_argv(command):
    if os.name == 'nt':
        exe = str(Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
        script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; " + command
        return [exe, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                base64.b64encode(script.encode('utf-16le')).decode()]
    return ['/bin/bash', '-c', command]
