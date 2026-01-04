$vms = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem
foreach ($vm in $vms) {
    Write-Output "VM: $($vm.ElementName) (State: $($vm.EnabledState))"
}
