const path = require('path');
const fs = require('fs-extra');
const { exec } = require('child_process');
const util = require('util');
const os = require('os');
const execAsync = util.promisify(exec);

class VMManager {
    constructor() {
        this.isWindows = os.platform() === 'win32';
    }

    async getScreenshot(name) {
        if (!this.isWindows) return null;
        const tempScript = path.join(os.tmpdir(), `draw_vm_${Date.now()}.ps1`);
        const script = `
            Add-Type -AssemblyName System.Drawing
            $ErrorActionPreference = 'SilentlyContinue'
            try {
                $vmObj = Get-VM -Name '${name}'
                $guid = $vmObj.Id.Guid
                $vm = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_ComputerSystem -Filter "Name='$guid'"
                $service = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_VirtualSystemManagementService
                $res = Invoke-CimMethod -InputObject $service -MethodName GetVirtualSystemThumbnailImage -Arguments @{ TargetSystem = $vm; WidthPixels = 800; HeightPixels = 600 }
                if ($res.ImageData) {
                    $ms = New-Object System.IO.MemoryStream(,$res.ImageData)
                    $bmp = New-Object System.Drawing.Bitmap($ms)
                    $ms2 = New-Object System.IO.MemoryStream
                    $bmp.Save($ms2, [System.Drawing.Imaging.ImageFormat]::Png)
                    $out = [Convert]::ToBase64String($ms2.ToArray())
                    $bmp.Dispose(); $ms.Dispose(); $ms2.Dispose()
                    Write-Output "IMG:$out"
                }
            } catch {
                Write-Output "ERR:$($_.Exception.Message)"
            }
        `;
        try {
            await fs.writeFile(tempScript, script);
            const { stdout } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempScript}"`, { maxBuffer: 1024 * 1024 * 10 });
            await fs.remove(tempScript).catch(() => { });

            const out = stdout.trim();
            if (out.startsWith("IMG:")) return out.substring(4);
            if (out.startsWith("ERR:")) console.error("[PS_SCREEN_ERR]", out);
            return null;
        } catch (e) {
            if (await fs.pathExists(tempScript)) await fs.remove(tempScript).catch(() => { });
            return null;
        }
    }

    async sendInput(name, type, data) {
        if (!this.isWindows) return;
        const script = `
            $vmObj = Get-VM -Name '${name}'
            $guid = $vmObj.Id.Guid
            if ('${type}' -eq 'key') {
                $kb = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_Keyboard -Filter "InstanceID like '%$guid%'"
                Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ keyCode = [int]${data.keyCode} }
            }
            if ('${type}' -eq 'mouse') {
                $mouse = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_Mouse -Filter "InstanceID like '%$guid%'"
                # Hyper-V mouse is absolute 0-65535
                Invoke-CimMethod -InputObject $mouse -MethodName SetMousePosition -Arguments @{ x = [int]${data.x}; y = [int]${data.y} }
                if ('${data.click}' -eq 'left') {
                    Invoke-CimMethod -InputObject $mouse -MethodName ClickMouseButton -Arguments @{ button = 1 }
                }
            }
        `;
        try {
            await execAsync(`powershell -NoProfile -Command "${script.trim().replace(/\n/g, ' ')}"`);
        } catch (e) { console.error("INPUT_ERR:", e.message); }
    }

    async getVMs() {
        if (this.isWindows) {
            const script = `Get-VM | ForEach-Object { 
                $adapters = Get-VMNetworkAdapter -VMName $_.Name;
                $ip = $adapters.IPAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1;
                if (-not $ip) { $ip = 'N/A' };
                [PSCustomObject]@{
                    Name = $_.Name;
                    State = [int]$_.State;
                    Uptime = $_.Uptime.TotalSeconds;
                    Memory = $_.MemoryAssigned / 1MB;
                    IP = $ip;
                    Notes = $_.Notes
                }
            } | ConvertTo-Json -Compress`;
            try {
                const { stdout, stderr } = await execAsync(`powershell -NoProfile -Command "${script.replace(/\n/g, ' ')}"`);
                if (stderr) throw new Error(stderr);
                if (!stdout.trim()) return [];
                const res = JSON.parse(stdout);
                const items = Array.isArray(res) ? res : [res];
                return items.map(v => {
                    const [os, password] = (v.Notes || 'windows').split('|');
                    return {
                        name: v.Name,
                        status: ([2, 3, 32768, 32770].includes(v.State) || v.State === 'Running') ? 'running' : 'stopped',
                        uptime: v.Uptime,
                        memory: Math.round(v.Memory),
                        ip: v.IP,
                        os: os || 'windows',
                        tempPass: password || ''
                    };
                });
            } catch (e) {
                console.error("GET_VMS_ERROR:", e.message);
                return [{ name: "ERREUR DE DROITS", status: "stopped", ip: "Vérifier Console", memory: 0, error: e.message }];
            }
        } else {
            return [];
        }
    }

    async control(name, action) {
        if (!this.isWindows) return;
        let cmd = "";
        if (action === 'start') cmd = `Start-VM -Name '${name}'`;
        if (action === 'stop') cmd = `Stop-VM -Name '${name}' -TurnOff`;
        if (action === 'restart') cmd = `Restart-VM -Name '${name}' -Force`;

        try {
            await execAsync(`powershell -NoProfile -Command "${cmd}"`);
        } catch (err) {
            const msg = err.stderr || err.message;
            if (msg.includes("0x800705AA") || msg.includes("mémoire")) {
                throw new Error("ERREUR RAM : Ton PC n'a pas assez de RAM libre pour démarrer cette VM. Ferme d'autres applis (Chrome, etc.) ou réduis la RAM de la VM dans l'Admin CP.");
            }
            throw new Error("Erreur Hyper-V : " + msg);
        }
    }

    async create(name, ram, cpu, disk, isoPath, osType = 'windows', password = '') {
        if (this.isWindows) {
            const dataDir = path.resolve(path.join(__dirname, '..', '..', 'data', 'vms'));
            await fs.ensureDir(dataDir);
            const vhdPath = path.join(dataDir, `${name}.vhdx`);
            const notes = `${osType}|${password}`;

            const script = `
                try {
                    $vm = New-VM -Name '${name}' -MemoryStartupBytes ${ram}MB -NewVHDPath '${vhdPath}' -NewVHDSizeBytes ${disk}GB -Generation 2 -ErrorAction Stop;
                    Set-VM -VMName '${name}' -ProcessorCount ${cpu} -StaticMemory -Notes '${notes}';
                    Set-VMFirmware -VMName '${name}' -EnableSecureBoot Off;
                    if ('${isoPath}') {
                        $dvd = Add-VMDvdDrive -VMName '${name}' -Path '${isoPath}' -ErrorAction SilentlyContinue;
                        $dvd = Get-VMDvdDrive -VMName '${name}';
                        Set-VMFirmware -VMName '${name}' -FirstBootDevice $dvd;
                    }
                    Connect-VMNetworkAdapter -VMName '${name}' -SwitchName 'Default Switch' -ErrorAction SilentlyContinue;
                } catch {
                    $err = $_.Exception.Message;
                    Write-Error "HYPERV_ERROR: $err";
                    exit 1;
                }
            `;

            try {
                const flattened = script.trim().replace(/\n/g, ' ').replace(/"/g, '`"');
                await execAsync(`powershell -NoProfile -Command "${flattened}"`);
            } catch (err) {
                throw new Error(err.stderr || err.message);
            }
        }
    }

    async deleteVM(name) {
        if (this.isWindows) {
            const script = `Stop-VM -Name '${name}' -TurnOff -ErrorAction SilentlyContinue; Remove-VM -Name '${name}' -Force;`;
            try {
                await execAsync(`powershell -NoProfile -Command "${script}"`);
                const dataDir = path.resolve(path.join(__dirname, '..', '..', 'data', 'vms'));
                const vhdPath = path.join(dataDir, `${name}.vhdx`);
                if (await fs.pathExists(vhdPath)) {
                    await fs.remove(vhdPath).catch(() => { });
                }
            } catch (err) {
                throw new Error(err.stderr || err.message);
            }
        }
    }
}

module.exports = new VMManager();
