$projectDir = $PSScriptRoot
$vbs = "$projectDir\run_hidden.vbs"

$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`"" -WorkingDirectory $projectDir
$triggers = @(
    (New-ScheduledTaskTrigger -Daily -At "01:00"),
    (New-ScheduledTaskTrigger -Daily -At "13:00")
)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName "PaybackCoupons" -Action $action -Trigger $triggers -Settings $settings -RunLevel Limited -Force | Out-Null
Write-Host "Task 'PaybackCoupons' created (triggers: 01:00, 13:00)."
