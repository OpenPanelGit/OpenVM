Add-Type -AssemblyName System.Drawing
$vm = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='test-4'"
if ($vm) {
    $service = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemManagementService
    $res = Invoke-CimMethod -InputObject $service -MethodName GetVirtualSystemThumbnailImage -Arguments @{ TargetSystem = $vm; WidthPixels = 640; HeightPixels = 480 }
    if ($res.ImageData) {
        Write-Output "Got Data: $($res.ImageData.Length) bytes"
        # On va essayer de voir si c'est un format connu
        try {
            $ms = New-Object System.IO.MemoryStream(,$res.ImageData)
            $bmp = New-Object System.Drawing.Bitmap($ms)
            Write-Output "Valid Image: $($bmp.Width)x$($bmp.Height)"
            $ms2 = New-Object System.IO.MemoryStream
            $bmp.Save($ms2, [System.Drawing.Imaging.ImageFormat]::Png)
            $bytes = $ms2.ToArray()
            Write-Output "PNG Data: $([Convert]::ToBase64String($bytes).Substring(0, 20))..."
        } catch {
            Write-Output "Drawing Error: $($_.Exception.Message)"
        }
    } else {
        Write-Output "No ImageData"
    }
} else {
    Write-Output "VM not found"
}
