// Small OS boundary for private state and explicit clipboard fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const psQuote = value => "'" + String(value).replaceAll("'", "''") + "'";
export const powershellPath = () => path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const psArgs = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$env:PSModulePath=$PSHOME+'\\Modules;'+$env:PSModulePath; " + script, 'utf16le').toString('base64')];
const ps = script => spawnSync(powershellPath(), psArgs("$ErrorActionPreference='Stop'; " + script), { encoding:'utf8', timeout:30000, windowsHide:true });
const protectedDirs = new Set();
export function privateDir(dir) {
  dir = path.resolve(dir);
  if (dir === os.homedir() || dir === path.parse(dir).root) throw new Error('Choose a dedicated private state directory, not home or a filesystem root');
  for (let p=dir; p!==path.dirname(p); p=path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('Private state path must not contain symlinks');
  }
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  if (process.platform !== 'win32') { fs.chmodSync(dir,0o700); return; }
  if (protectedDirs.has(dir)) return;
  const r=ps(`$p=${psQuote(dir)}
if ((Get-Item -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$a=New-Object Security.AccessControl.DirectorySecurity
$a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false)
foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
 $who=New-Object Security.Principal.SecurityIdentifier($id)
 $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
Set-Acl -LiteralPath $p -AclObject $a`);
  if (r.status!==0) throw new Error('Cannot secure the private state directory with a Windows ACL');
  protectedDirs.add(dir);
}
export function privateFileOk(file) {
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) return false;
  if (process.platform !== 'win32') return !(fs.statSync(file).mode & 0o077);
  return ps(`$allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
foreach($r in (Get-Acl -LiteralPath ${psQuote(file)}).Access) {
 $sid=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
 if($r.AccessControlType -eq 'Allow' -and $sid -notin $allowed) { exit 2 }
}`).status===0;
}
export function clipboard(clear=false) {
  const candidates = process.platform==='darwin' ? [[clear?'pbcopy':'pbpaste',[]]] :
    process.platform==='win32' ? [[powershellPath(),psArgs(clear?"Set-Clipboard -Value ''":"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Clipboard -Raw")]] :
    [[clear?'wl-copy':'wl-paste',clear?['--clear']:['--no-newline']],['xclip',['-selection','clipboard',clear?'-i':'-o']]];
  for(const [exe,args] of candidates) {
    const r=spawnSync(exe,args,{input:clear?'':undefined,encoding:'utf8',timeout:5000,windowsHide:true});
    if(r.status===0) return (r.stdout||'').trim();
  }
  throw new Error('No usable clipboard backend; prefer automatic private key capture from the bound page');
}
