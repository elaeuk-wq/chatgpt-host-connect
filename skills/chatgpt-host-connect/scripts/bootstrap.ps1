# Windows dependency preparation. Dot-source from the adapter; no action on load.
# The adapter reads private stdin BEFORE calling this function.
function Find-HostPython {
    $probe = 'import sys; assert sys.version_info >= (3,9); print(sys.executable)'
    foreach ($candidate in @('py','python3','python')) {
        $exe = Get-Command $candidate -ErrorAction SilentlyContinue
        if (!$exe -or $exe.Source -like '*\WindowsApps\python*.exe') { continue }
        $args = @('-c',$probe)
        if ($candidate -eq 'py') { $args = @('-3') + $args }
        $result = & $exe.Source @args 2>$null
        if ($LASTEXITCODE -eq 0 -and $result -and (Test-Path -LiteralPath ($result | Select-Object -Last 1))) {
            return ($result | Select-Object -Last 1)
        }
    }
    # winget installs per-user Python without updating this process's PATH.
    foreach ($key in @('HKCU:\Software\Python\PythonCore\*\InstallPath','HKLM:\Software\Python\PythonCore\*\InstallPath')) {
        foreach ($item in @(Get-ItemProperty $key -ErrorAction SilentlyContinue)) {
            $exe = $item.ExecutablePath
            if (!$exe) { $exe = Join-Path $item.'(default)' 'python.exe' }
            if ($exe -and (Test-Path -LiteralPath $exe)) {
                $result = & $exe -c $probe 2>$null
                if ($LASTEXITCODE -eq 0) { return ($result | Select-Object -Last 1) }
            }
        }
    }
    return $null
}
function Prepare-HostPython([bool]$AllowInstall) {
    $python = Find-HostPython
    if ($python) { return $python }
    if (!$AllowInstall) { throw 'Python 3.9+ is missing on the target; install first with authorized setup.' }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (!$winget) { throw 'Python 3.9+ and winget are missing. Install Python from python.org (current user), then resume.' }
    & $winget.Source install --id Python.Python.3.13 --exact --source winget --scope user --silent --disable-interactivity --accept-package-agreements --accept-source-agreements 1>&2
    if ($LASTEXITCODE -ne 0) { throw 'Python installation failed. Check Windows package-manager policy/network; do not bypass admin approval.' }
    $python = Find-HostPython
    if (!$python) { throw 'Installed Python was not found; open a new terminal and resume.' }
    return $python
}
