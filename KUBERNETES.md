# Kubernetes Lab

The JavaScript service now runs in a local Kubernetes cluster named `shortener`.
This lesson uses k3d 5.9.0 and K3s v1.36.3+k3s1 with one server node and no agents.
Docker Desktop must be running. All commands below run in PowerShell.

The active learning path is now [OPERATIONS.md](OPERATIONS.md): delivery and
incident handling for an application owner. The commands here are a reference,
not a list of exercises that must be repeated. Current image version: 3.3.0.
The accepted artifact is now pulled from a local registry; see CI-CD.md for the
tested candidate gates and the localhost-to-node registry mapping.

Database migrations now run as a bounded Job before API rollout. TITLE-RELEASE.md
records the actual 3.3 -> 3.2 -> 3.3 verification and the feature-traffic gate.
Use the registry release command with `--backup <verified-backup-id>`; applying
the API manifest alone does not migrate a fresh database.

## Open a learning session

```powershell
cd E:\k8s-learning\shortener
Set-Alias -Name kubectl -Value "E:\k8s-learning\shortener\scripts\kubectl-lab.cmd"
Set-Alias -Name k3d -Value "E:\k8s-learning\bin\k3d.exe"
$env:KUBECONFIG = "E:\k8s-learning\kubeconfig.yaml"
kubectl get nodes
kubectl -n shortener get pods
curl.exe http://127.0.0.1:8081/health
```

Run the setup commands again when opening a new terminal. These are individual
PowerShell commands, so they also work when the execution policy blocks `.ps1`
scripts. They do not change the execution policy or require administrator rights.
The kubectl entry point selects only this lab's cluster and keeps its credentials
and discovery cache on E:. The aliases apply only to the current session.

The optional `. .\scripts\use-k8s.ps1` convenience script provides equivalent
setup when your PowerShell session permits local scripts. If it reports that
running scripts is disabled, use the commands above instead.

Expected workload: two `api-...` Pods and one `db-0` Pod, all `1/1 Running`.

## What runs where

| Object | Lab role |
| --- | --- |
| Node | `k3d-shortener-server-0`, a Kubernetes node running inside Docker |
| Namespace | `shortener`, which groups this project's resources |
| Deployment | `api`, which maintains two application replicas |
| Pod | One running instance of the application or database in this lab |
| Service | A stable network entry point for selected Pods |
| StatefulSet | `db`, which manages the database Pod `db-0` |
| PVC | `data-db-0`, the database's persistent storage claim |
| ConfigMap | `api-config`, with non-secret connection settings |
| Secret | `db-credentials`, created from the existing local `.env` |

The request path is Windows `127.0.0.1:8081`, then the node's port `30080`,
then one ready API Pod at port `8000`. The API connects to PostgreSQL through
`db-client:5432`. The headless Service `db` supplies StatefulSet network identity.

Kubernetes uses a separate database from Compose. Old Compose links are not
automatically copied; the original Compose volume remains untouched.

## Observe automatic replacement

Record the Pod names, delete just one application Pod, and watch its replacement:

```powershell
kubectl -n shortener get pods
$pod = kubectl -n shortener get pods -l app=api -o jsonpath='{.items[0].metadata.name}'
kubectl -n shortener delete pod $pod
kubectl -n shortener get pods -w
```

Press Ctrl+C to stop watching. The Deployment's ReplicaSet creates a new Pod to
restore two replicas. The replacement has a different name/UID; it is not the
deleted Pod coming back to life.

```powershell
kubectl -n shortener rollout status deployment/api --timeout=60s
curl.exe http://127.0.0.1:8081/health
```

## Create and inspect a link

```powershell
$link = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8081/links" -ContentType "application/json" -Body '{"url":"https://example.com"}'
$shortUrl = "http://127.0.0.1:8081$($link.short_path)"
curl.exe -i $shortUrl
kubectl -n shortener exec db-0 -- psql -U shortener -d shortener -c "SELECT code, url FROM links ORDER BY created_at DESC LIMIT 5;"
```

The response should be 307 with a Location header. Both application replicas
read the same PostgreSQL database.

## Linux and logs

```powershell
kubectl -n shortener logs -l app=api -c api --tail=20 --prefix
kubectl -n shortener exec -it deployment/api -c api -- sh
```

Inside the container run `pwd`, `ls -l`, `whoami`, and `ps` separately. Use `exit`
to return to PowerShell. This connects the earlier Linux and Docker exercises
to the same application running under Kubernetes.

## Storage and checks

The app uses `/live` for liveness and `/health` for readiness. `/health` queries
PostgreSQL. A database outage makes the app unready without deliberately
restarting every app container. Database replacement can cause a brief outage:
there is only one database replica and one Kubernetes node in this lab.

```powershell
$env:TEST_BASE_URL = "http://127.0.0.1:8081"
npm test
npm run test:k8s
Remove-Item Env:TEST_BASE_URL
```

The six smoke checks verify endpoints and invalid input handling. The Kubernetes
test verifies both app replicas, deletes one API Pod and waits for a different
Pod, then replaces `db-0` and checks that the same PVC and short link survive.
It briefly interrupts the database and leaves a sample row in the database.
It expects two API replicas. It never deletes a PVC or namespace.

## Locations and stopping

| Content | Location |
| --- | --- |
| Tools | `E:\k8s-learning\bin` |
| Cluster credentials | `E:\k8s-learning\kubeconfig.yaml` |
| kubectl cache | `E:\k8s-learning\.kube-cache` |
| Project manifests | `E:\k8s-learning\shortener\k8s` |
| Cluster configuration | `E:\k8s-learning\shortener\infra\k3d.yaml` |
| Image export and temporary files | `E:\k8s-learning\tmp` |
| Database storage | Docker volume `shortener-k8s-storage`, in the E: Docker data disk |

Stop/start the existing cluster while retaining its state:

```powershell
k3d cluster stop shortener
k3d cluster start shortener
kubectl -n shortener rollout status statefulset/db --timeout=120s
kubectl -n shortener rollout status deployment/api --timeout=120s
```

To return to Compose instead, stop the Kubernetes cluster, then run
`docker compose up -d --wait` and use port 8080. To switch back, run
`docker compose stop` followed by `k3d cluster start shortener`, then use port 8081.

Retaining a PVC protects this lab against Pod replacement, not every possible
failure. Deleting its namespace/PVC, deleting the cluster, or deleting Docker
volumes can make data unavailable or remove it. Stop the cluster when taking a
break; do not delete it as a routine shutdown. A logical backup and isolated
restore have been verified; see BACKUP-RECOVERY.md. Both source and backup are
on E:, so there is still no off-device protection.

## Reproduce the initial deployment

These steps are for a fresh cluster, not required each time you open a terminal.
The installed E: binaries, local `.env`, and successful release report
are prerequisites. Registry-backed releases require their retained registry data;
older tar-import releases require the recorded archive. The local proxy must be
running when using the machine-specific proxy settings below.

```powershell
Set-Alias -Name kubectl -Value "E:\k8s-learning\shortener\scripts\kubectl-lab.cmd"
Set-Alias -Name k3d -Value "E:\k8s-learning\bin\k3d.exe"
$env:KUBECONFIG = "E:\k8s-learning\kubeconfig.yaml"
$env:TEMP = "E:\k8s-learning\tmp"
$env:TMP = $env:TEMP
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:NO_PROXY = "127.0.0.1,localhost,::1"
docker compose stop
k3d cluster create --config infra/k3d.yaml
k3d kubeconfig merge shortener --output E:\k8s-learning\kubeconfig.yaml
$release = Get-Content .releases/last-success.json -Raw | ConvertFrom-Json
if ($release.delivery -eq 'registry') {
  node scripts/setup-registry.js
  if ($LASTEXITCODE -ne 0) { throw 'Resolve registry setup before applying workloads' }
} else {
  k3d image import $release.archive --cluster shortener --mode direct
  docker exec k3d-shortener-server-0 ctr --address /run/k3s/containerd/containerd.sock --namespace k8s.io images tag --force "docker.io/library/$($release.image)" $release.imageRef
}
docker image save --platform linux/amd64 --output E:\k8s-learning\tmp\postgres-amd64.tar postgres:17-alpine
k3d image import E:\k8s-learning\tmp\postgres-amd64.tar --cluster shortener --mode direct
.\scripts\deploy-k8s.ps1
```

Before fresh deployment, confirm the digest in `k8s/30-api.yaml` matches
`$release.imageRef`. For application updates, use the release workflow in
OPERATIONS.md and reconcile the approved digest into that manifest after the
release passes. The current checked-in-style manifest already matches the
verified 3.2.0 artifact. ConfigMap environment changes also require replacing
the app Pods, for example with `kubectl -n shortener rollout restart deployment/api`.

The deployment script preserves existing credentials. Changing `.env` after
database initialization does not automatically rotate PostgreSQL's password.

If `.ps1` scripts are disabled, the already-deployed lab needs no deployment
script to continue the exercises. For a fresh deployment in such a session, run
the following individual commands instead of `deploy-k8s.ps1`. Create the Secret
only when it does not already exist:

```powershell
kubectl apply -f k8s/00-namespace.yaml
kubectl -n shortener get secret db-credentials
# On a fresh cluster only, if the previous command reports NotFound:
kubectl -n shortener create secret generic db-credentials --from-env-file=.env
kubectl apply -f k8s/10-config.yaml -f k8s/20-database.yaml
kubectl -n shortener rollout status statefulset/db --timeout=180s
kubectl apply -f k8s/30-api.yaml
kubectl -n shortener rollout status deployment/api --timeout=120s
```

## References

- https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
- https://kubernetes.io/docs/concepts/storage/persistent-volumes/
- https://k3d.io/stable/usage/k3s/
