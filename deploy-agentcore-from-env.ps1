$ErrorActionPreference = "Stop"

Set-Location "$PSScriptRoot"

if (-not (Test-Path ".env")) {
    throw "Missing .env in repo root"
}

$envMap = @{}
Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $parts = $line -split "=", 2
    if ($parts.Count -ne 2) { return }
    $key = $parts[0].Trim()
    $value = $parts[1].Trim()
    $envMap[$key] = $value
}

$required = @("MODEL_ID", "PRICE_BUCKET", "PRICE_KEY")
$missing = @()
foreach ($k in $required) {
    if (-not $envMap.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($envMap[$k])) {
        $missing += $k
    }
}
if ($missing.Count -gt 0) {
    throw "Missing required keys in .env: $($missing -join ', ')"
}

$agentName = "test_us1_sensei_calculatoragent"

$envArgs = @()

function Add-EnvArg {
    param([string]$Key)
    if ($envMap.ContainsKey($Key) -and -not [string]::IsNullOrWhiteSpace($envMap[$Key])) {
        $script:envArgs += "--env"
        $script:envArgs += "$Key=$($envMap[$Key])"
    }
}

# Core runtime inputs
Add-EnvArg "MODEL_ID"
Add-EnvArg "PRICE_BUCKET"
Add-EnvArg "PRICE_KEY"

# Runtime identity and observability context used by my_agent1.py
Add-EnvArg "AGENT_NAME"
Add-EnvArg "AGENTCORE_RUNTIME_ID"
Add-EnvArg "AGENT_ARN"
Add-EnvArg "AWS_ACCOUNT_ID"
Add-EnvArg "AWS_REGION"
Add-EnvArg "BEDROCK_REGION"
Add-EnvArg "RUNTIME_LOG_GROUP"
Add-EnvArg "RUNTIME_LOG_STREAM"
Add-EnvArg "OTEL_RESOURCE_ATTRIBUTES"

Write-Host "Deploying AgentCore with env from .env for agent '$agentName'..."
& agentcore deploy --agent $agentName @envArgs
