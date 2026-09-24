$learningRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$labBin = Join-Path $learningRoot 'bin'
$env:KUBECONFIG = Join-Path $learningRoot 'kubeconfig.yaml'
if (($env:PATH -split ';') -notcontains $labBin) {
    $env:PATH = "$labBin;$env:PATH"
}

# A native command preserves kubectl exec's -- separator and pipeline input.
Set-Alias -Name kubectl -Value (Join-Path $PSScriptRoot 'kubectl-lab.cmd') -Scope Global

Write-Host "Kubernetes context: k3d-shortener; kubeconfig: $env:KUBECONFIG"
