$projectDir = $PSScriptRoot
$vbs = "$projectDir\run_hidden.vbs"

foreach ($hour in @("01:00", "13:00")) {
    $taskName = "PaybackCoupons_$($hour.Replace(':', ''))"
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`"" -WorkingDirectory $projectDir
    $trigger = New-ScheduledTaskTrigger -Daily -At $hour
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
    Write-Host "Task '$taskName' created."
}
