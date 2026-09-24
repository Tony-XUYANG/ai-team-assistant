$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'use-k8s.ps1')
$projectDir = Split-Path $PSScriptRoot -Parent
$clusterDir = Join-Path $projectDir 'k8s'

Push-Location $projectDir
try {
    kubectl apply -f (Join-Path $clusterDir '00-namespace.yaml')
    if ($LASTEXITCODE -ne 0) { throw 'Namespace creation failed.' }

    $secret = kubectl -n shortener get secret db-credentials --ignore-not-found -o name
    if ($LASTEXITCODE -ne 0) { throw 'Secret lookup failed.' }
    if (-not $secret) {
        kubectl -n shortener create secret generic db-credentials --from-env-file=.env
        if ($LASTEXITCODE -ne 0) { throw 'Secret creation failed.' }
    }

    kubectl apply -f (Join-Path $clusterDir '10-config.yaml') -f (Join-Path $clusterDir '20-database.yaml')
    if ($LASTEXITCODE -ne 0) { throw 'Database deployment failed.' }
    kubectl -n shortener rollout status statefulset/db --timeout=180s
    if ($LASTEXITCODE -ne 0) { throw 'Database did not become ready.' }

    $schema = kubectl -n shortener exec db-0 -c postgres -- sh -c 'psql -X -q -A -t -v ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" -c "SELECT count(*) FROM information_schema.columns WHERE table_schema=''public'' AND table_name=''links'' AND column_name=''title'' AND data_type=''character varying'' AND character_maximum_length=120 AND is_nullable=''YES'';"'
    if ($LASTEXITCODE -ne 0 -or "$schema".Trim() -ne '1') {
        throw 'Schema is not ready for 3.3. Use the verified registry release migration workflow before applying the API. This helper does not migrate a fresh database.'
    }

    kubectl apply -f (Join-Path $clusterDir '30-api.yaml')
    if ($LASTEXITCODE -ne 0) { throw 'API deployment failed.' }
    kubectl -n shortener rollout status deployment/api --timeout=120s
    if ($LASTEXITCODE -ne 0) { throw 'API did not become ready.' }
    kubectl -n shortener get 'pods,services,pvc'
} finally {
    Pop-Location
}
