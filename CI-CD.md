# Candidate Testing and Registry-Backed Delivery

## What is running

This lab now has an executed local delivery pipeline: source tests, a built-image
acceptance gate with a disposable PostgreSQL database, a local OCI registry,
deployment by verified digest, live acceptance checks and guarded rollback.

Run it from `E:\k8s-learning\shortener`:

```powershell
node scripts/release-local.js --registry --backup <verified-backup-id>
```

Use `node scripts/ci.js` for tests and a candidate build without publication or
deployment. Both commands use JavaScript. No Python or execution-policy change is
needed. Generated reports, Docker data, temporary files and registry data remain
on E: on this machine.

The application now reports 3.3.0 and supports optional persisted titles. See
TITLE-RELEASE.md for the executed migration Job, mixed-image tests, and actual
3.3 -> 3.2 -> 3.3 rollback verification. A successful verified backup is required
before live migration. Unique image tags, a recorded source fingerprint, and immutable
platform digests distinguish delivery artifacts with the same app version.

The public source repository is `Tony-XUYANG/ai-team-assistant`; `origin` points
to GitHub and the default development branch is `main`. Local credentials,
backups and generated reports are excluded from Git. Source publication does not
upload the application image to a public registry or deploy the application.
Use the repository's Actions tab to inspect hosted CI results for a specific commit.

## The tested stages

1. Take the same local lock used by release, outage and backup operations. Check
   that the lab Deployment is healthy and record its UID, generation and template.
2. Run the isolated source test suite. A failing, skipped, cancelled or pending test
   rejects the candidate before building or publication.
3. Build the application once for linux/amd64 with a unique tag. Record the source
   fingerprint and the candidate platform digest. The fingerprint covers runtime
   files, dependency metadata, Docker inputs, scripts, tests, infrastructure and
   workflow files; it is not a signed source attestation or a Git commit.
4. Start a disposable PostgreSQL database with new credentials, no published ports
   and no external network. Start the exact candidate image in that network
   namespace with a read-only root filesystem and non-root user. Install only the
   acceptance tests into a bounded tmpfs, not into the candidate image.
5. Run the candidate's migration, test its repeat behavior and missing-schema
   startup rejection. Execute 11 real API acceptance checks: title persistence,
   title validation, metadata reads, health,
   liveness, link creation and redirect, invalid/oversized input, missing routes,
   version and request IDs. Source database credentials and PVCs are not used.
6. Remove the isolated containers. Recheck source and image identity before
   publication, then push only to this lab's `localhost:5001/shortener` repository.
   Verify the registry response bytes and digest match the tested candidate.
7. Run the verified candidate's migration Job and inspect its result. Then patch
   the Kubernetes Deployment with UID/generation preconditions. Deploy
   `localhost:5001/shortener@sha256:...`, never a mutable `latest` reference.
   This path does not import a tar archive into the cluster.
8. Wait for rollout; verify both Pod versions and image references. Run the 11 live
   acceptance checks, check a saved link and inspect health samples. Preserve
   actual image-availability events; the migration Job may have already pulled
   the candidate onto the node. Registry bytes and digest are verified separately.
9. On deployment/acceptance failure, restore the prior template only if the live
   UID, generation and release marker still belong to this operation. On success,
   update `.releases/last-success.json`. Reconcile the accepted digest into
   `k8s/30-api.yaml` only after final acceptance. With `--verify-rollback`, validate
   the old template and retained title data, then roll forward to the same candidate.

The deployment checks cannot prevent every regression; the accepted candidate
can still behave differently with real data, permissions or load. The startup
failure exercise demonstrates why a passing CI run is not sufficient on its own.

## Observed evidence: September 24, 2026

| Run | Verified outcome |
| --- | --- |
| Intentional source-test failure | Exit 1; no registry push; no Deployment patch; original generation/image unchanged |
| Initial candidate integration attempt | Rejected before push because Docker refused `docker cp` into a read-only container; disposable containers removed |
| First successful registry delivery | 24 source tests, 9 candidate checks and 9 live checks passed; 34 healthy samples, 0 failures |
| Intentional bad startup command after CI | Candidate tests passed but rollout failed; prior template restored; saved link retained; 74 healthy samples, 0 failures; command still exited 1 |
| Final delivery with diagnostic redaction | 25 source tests, 9 candidate checks and 9 live checks passed; 36 healthy samples, 0 failures |

Evidence under `.releases/`, in the same order:

```text
2026-09-24T07-07-23-592Z-b3e73b1b
2026-09-24T07-15-07-963Z-adc54caf
2026-09-24T07-18-44-166Z-17941788
2026-09-24T07-20-41-759Z-4d5e35f1
2026-09-24T07-32-06-530Z-bf2b4817
```

The final accepted reference, also recorded in `k8s/30-api.yaml`, is:

```text
localhost:5001/shortener@sha256:508ffe29dc24be8c1f0f7356fc95a790223ce7256a61d6ba05ba8d6f2c5e1506
```

The final run captured a successful registry pull for the first new Pod. The
second Pod used the same node's cache. This is expected in a one-node cluster;
it does not mean every replica downloaded every layer again. Sampled health
success does not establish a production zero-downtime guarantee.

The read-only-root failure was fixed by sending the three test files through
stdin to a Node process that writes only the dedicated tmpfs. The root filesystem
restriction was retained. Container inspection originally logged disposable
database passwords; those earlier logs were sanitized, new diagnostics redact
them, and an added regression test verifies the redaction. No source database
credentials were used by these test containers.

## Registry and runtime details

| Component | Location |
| --- | --- |
| Registry container | `shortener-registry` |
| Host endpoint | `http://127.0.0.1:5001` |
| Image-name prefix | `localhost:5001/shortener` |
| Registry storage | `E:\k8s-learning\registry-data` |
| Registry Compose config | `infra/registry.compose.yaml` |
| Node-side endpoint | `http://shortener-registry:5000`, inside Docker network `k3d-shortener` |
| Registry setup entry point | `node scripts/setup-registry.js` |

Host localhost and node localhost are different network namespaces. The node
uses an explicit mirror/hosts mapping from the image-name prefix to the registry
container, while Windows Docker pushes through the loopback port mapping.

The setup script first checks the node, existing registry ownership and storage.
It installs a host-scoped containerd `hosts.toml` under the existing `config_path`
for immediate use. This did not require a node restart. It also writes the
equivalent K3s `registries.yaml` for K3s startup. K3s normally reads that file at
startup and generates runtime configuration from it.

The setup script refuses to overwrite differing registry configuration. K3s may
regenerate `hosts.toml` on a future restart. A stop/start cycle was not tested in
this work item. If setup later reports a difference, inspect the generated config
and its endpoint before reconciling it; do not delete arbitrary registry configs
or restart the node merely to bypass this check.

The registry is HTTP and unauthenticated. Its Windows listener is loopback-only,
but containers on the same Docker network can reach it. It is not a secure
multi-user registry. Do not publish that port to a LAN or put production artifacts
or credentials into this setup. A shared deployment requires TLS, authentication,
least-privilege publication and pull access, and retention/recovery policies.

Do not delete registry data or old accepted artifacts as routine cleanup. Running
Pods may remain healthy from cached images even when a replacement Pod can no
longer pull its image. The registry is kept running intentionally. Stop it during
a lab break only when you are not deploying or replacing Pods:

```powershell
docker compose -f infra/registry.compose.yaml stop
```

Start it again with the same Compose file using `up -d`. Do not use volume pruning
as a release or rollback step. There is no registry retention/garbage-collection
automation or off-device registry backup configured.

## Developer decisions

| Symptom | Evidence and action |
| --- | --- |
| Source or candidate test fails | Read `ci/ci-report.json` and the TAP output; fix code/test expectations; do not bypass the gate |
| Build succeeds but push fails | Check the registry endpoint, storage and network; no Deployment should have changed |
| `ImagePullBackOff` | Compare the exact image digest, registry availability and node-side mapping; application logs may not exist yet |
| New image starts but is not Ready | Inspect startup/configuration/dependency evidence and decide whether to roll back |
| CI passes but deployed acceptance fails | Keep failed-release evidence and validate recovery; CI is not a production acceptance guarantee |
| Rollback succeeds | The release is still unsuccessful and exits nonzero; confirm old data and previous template |
| Another operator changed the Deployment | Stop automatic rollback rather than overwrite concurrent work |

Your deliverable is a traceable, tested artifact plus release/recovery evidence,
not simply a Docker image that builds. Git commit provenance, artifact signing,
security scans and approvals remain additional controls for a team environment.

## GitHub Actions: candidate checks

`.github/workflows/ci.yml` runs the candidate-testing entry point on push, pull
request or manual trigger in the GitHub repository. It uses
an Ubuntu runner, Node 24 and a configured Docker containerd image store. Actions
are pinned by full commit SHA. The token has `contents: read`; checkout credentials
are not persisted. The workflow has no registry-push permission, source database
credentials, kubeconfig, deployment job or production environment secret.

The workflow was checked with actionlint 1.7.12 (archive checksum verified). Shell
and Python external lint integrations were disabled for that syntax check. The
syntax check alone does not prove a hosted run succeeds. Check the run attached
to the relevant Git commit for Docker download, runner, build and test results.

The cloud workflow cannot directly reach this Windows loopback registry or the
local cluster. Do not give untrusted pull-request code a runner with this host's
Docker socket or production credentials. Connecting hosted CI to deployment
still requires an explicitly selected registry, runner/network design,
permissions, approvals and a deployment identity. None is provided to this workflow.

## Limits and recovery of interrupted tooling

This is a local, manually invoked pipeline with a GitHub CI definition, not GitOps
or continuously running cloud automation. It has one Kubernetes node, a local
filesystem lock and no protected branch, environment approval, SBOM, signature,
vulnerability gate, central artifact audit store or tested registry disaster
recovery. The lock does not coordinate other machines. Source fingerprints are
change detection, not protection against malicious edits by privileged users.

Handled failures clean up the temporary containers. A forced process termination
or host failure can leave containers/locks or an uncertain rollout. Inspect the
specific report, container labels and live Deployment before cleanup or retry.
Never broadly prune containers, images or volumes to resolve an uncertain run.

The earlier tar-import flow is historical. The current schema-aware runner
rejects releases without `--registry` and a verified `--backup` ID; it does not
export an image tar. Use TITLE-RELEASE.md for the current delivery procedure.

## Official references

- Containerd registry hosts: `https://github.com/containerd/containerd/blob/main/docs/hosts.md`
- K3s registries: `https://docs.k3s.io/installation/private-registry`
- GitHub workflow syntax: `https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax`
- Docker runner configuration: `https://github.com/docker/setup-docker-action`
