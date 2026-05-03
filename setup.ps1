$vbs = "$PSScriptRoot\run_hidden.vbs"

schtasks /create /tn "PaybackCoupons_01" /tr "wscript.exe `"$vbs`"" /sc daily /st 01:00 /ru $env:USERNAME /f
schtasks /create /tn "PaybackCoupons_13" /tr "wscript.exe `"$vbs`"" /sc daily /st 13:00 /ru $env:USERNAME /f

Write-Host "Tasks created."
