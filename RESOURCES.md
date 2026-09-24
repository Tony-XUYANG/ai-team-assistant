# Resource Limits and Performance Investigation

## Your responsibility as the application owner

Explain a symptom with evidence, choose a bounded mitigation, and verify both
recovery and data preservation. Do not memorize shell commands or treat a green
Pod as proof that users receive acceptable latency. This exercise links the real
Node.js application, Docker CPU quotas, Linux cgroup counters, and a Kubernetes
OOM termination. It does not size the application for production.

Run from `E:\k8s-learning\shortener` with `npm.cmd run drill:resources`.
The JavaScript entry point is `scripts/drill-resources.js`. Raw samples, resource
counters, the disposable Pod manifest, logs, and report are under `.incidents/`
on E:. Run `npm.cmd run test:resources` for focused local tests.

## Verified experiment: September 24, 2026

Initial successful report:
`.incidents/resources-2026-09-24T07-57-23-385Z-9a9fead6/report.json`.
This tested the already accepted 3.2.0 image by immutable image ID. It did not
build or release new application code. The live Deployment remained unchanged.

The live service received six baseline health requests, then 47 low-frequency
health samples during the experiment. All returned 200. Both API Pods and the
database Pod retained their UIDs and restart counts. The PVC identity, backing
volume, live workload specifications, and existing release-marker link were
verified unchanged. Temporary containers and the memory Pod were removed.

Repeat verification after the terminal-Pod check and cleanup safeguards were
finalized:
`.incidents/resources-2026-09-24T08-01-34-438Z-349cb35c/report.json`.
The second run succeeded with all 49 live health samples returning 200, the
same preservation checks passing, and no remaining temporary resources or lock.
The disposable memory Pod reached phase `Failed` with reason `OOMKilled` and
zero restarts. All 40 local unit and live endpoint regression tests passed;
this was not a hosted CI run or a new candidate-image release.

| Repeat round | Successful/s | P95 latency | Throttled periods | Not sent: busy / late |
| --- | --- | --- | --- | --- |
| 500m normal | 198.88 | 1.59 ms | 2.38% | 0 / 9 |
| 50m restricted | 164.35 | 284.74 ms | 96.63% | 277 / 0 |
| 500m restored | 199.27 | 1.34 ms | 0% | 0 / 6 |

Both runs support the same diagnosis; the different exact values also show why
this short local test must not be presented as a production capacity guarantee.

### CPU comparison

One real API container, one isolated temporary PostgreSQL database, one stored
link, and a separate load-generator container were used throughout. The only
application resource setting changed between rounds was the CPU limit. Each
round offered 200 arrivals/s for eight seconds, following a short warmup.

| Round | CPU limit | Successful/s | P95 latency | Throttled periods | Not sent: busy / late |
| --- | --- | --- | --- | --- | --- |
| Normal | 500m | 199.87 | 1.53 ms | 1.19% | 0 / 1 |
| Restricted | 50m | 160.96 | 325.56 ms | 97.73% | 307 / 4 |
| Restored | 500m | 199.76 | 1.23 ms | 0% | 0 / 2 |

Each round planned 1,600 arrivals. Actual successful redirects were 1,599,
1,289, and 1,598; all sent requests returned the expected 307 and destination.
The generator does not follow external redirects. It never exceeds 32 in-flight
requests or replays missed arrivals in a burst. The restricted round therefore
did NOT sustain the offered rate, despite having no HTTP errors. Ignoring
unissued arrivals would make the result misleading.

P95 is the nearest-rank 95th percentile of all sent attempts, including failures
if present. Unissued arrivals have no measured latency and are reported
separately. Successful/s includes any drain time after arrivals stop. The
generator reports scheduling lag, busy drops, late drops and its own cgroup CPU
counters so client-side bottlenecks are visible.

Linux `cpu.max` was verified as `50000 100000`, then `5000 100000`, then
`50000 100000`. The throttled-period ratio is the delta of `nr_throttled` divided
by the delta of `nr_periods`, not CPU utilization and not the percentage of wall
time lost. Do not divide aggregate `throttled_usec` by elapsed time and label
that as CPU utilization. Counter windows include small measurement overheads
outside the HTTP interval. [1][2][3]

Database throttling was zero in all three measured windows. The generator had
1-2 throttled periods per window and a few late arrivals, so this is not a
laboratory-grade benchmark. Nevertheless, changing only the API quota caused
large latency degradation that reversed on restoration. This strongly supports
API CPU throttling as the main cause in THIS experiment; it does not prove that
every production latency incident has that cause.

### Memory experiment

A separate Pod used the accepted image but overrode its command with a bounded
synthetic allocation program. It deliberately retained and touched 8MiB Buffers
every 200ms. The memory limit was 96Mi, swap limit was verified as zero, and the
Pod had no database credentials, mounted storage, or matching Service selector.
It used `restartPolicy: Never` and a 45-second Pod deadline.

Kubernetes recorded `reason: OOMKilled`, exit code 137, and zero restarts.
The initial report captured a transient Pod phase of Running alongside a
terminated container; container termination was the evidence, not that phase.
The runner now waits for terminal Pod phase as well. Exit 137 alone would not
distinguish OOM from another SIGKILL. [4][5]

The last pre-kill sample showed approximately 4.27MiB V8 heap used but 80.13MiB
of ArrayBuffer allocations. Node Buffers are included in `arrayBuffers` and
`external`, not just V8 heap usage. Process RSS and cgroup memory usage measure
different scopes and need not match. This is why an apparently small heap does
not rule out container memory exhaustion. [2][4]

The process could not log its own death. Its final `memory.events` samples were
taken BEFORE the kill, so their zero `oom_kill` counters are not post-kill proof.
The runtime's Kubernetes termination reason supplies that evidence here. No
memory leak in the actual shortener was established by this synthetic exercise.

## Decisions to make on a real project

| Evidence | Application-owner decision |
| --- | --- |
| High latency, API quota throttling, DB relatively quiet | Reproduce against expected traffic; profile expensive work; compare CPU limits under the same load before proposing a quota change |
| Errors absent but offered load not achieved | Investigate latency/backpressure and load-generator drops; do not report the offered rate as supported throughput |
| OOMKilled | Preserve prior logs and memory trends; separate a too-small budget, growing retained state, workload spikes, and Buffer/native memory growth |
| Memory climbs after each repeated workload | Obtain a bounded reproduction and retention evidence; raising the limit may buy time but does not establish a fix |
| Database/pool time dominates | Investigate queries, indexes and connection wait; adding API replicas can add DB connections instead of removing the bottleneck |
| A proposed resource change improves latency | Also check errors, saturation, recovery, headroom, rollout surge and dependency capacity before acceptance |

Requests are used in placement and resource sharing; limits bound consumption.
In particular the current `requests.cpu: 50m` is NOT a 50m ceiling: the live API
limit is 500m. CPU quota enforcement can delay work, while memory-limit pressure
can lead to an OOM kill. The lab intentionally leaves the live requests and
limits unchanged. [1]

For this application, pool.max is 5 per API replica and PostgreSQL allows 30
connections. Two replicas can use up to 10 application connections; a rolling
surge to three can use up to 15. Leave room for administration, initialization,
and other clients. This arithmetic is a constraint, not a capacity measurement.

Before a production sizing decision, define route-specific traffic and latency
objectives, realistic data volume and read/write mix, long-enough steady and
burst loads, failure/recovery criteria, and memory headroom. This eight-second,
single-link, local-network experiment supplies none of those production guarantees.

## Safeguards and recovery boundary

- Uses the same exclusive `.releases/active.lock` as the other local operations.
- Requires healthy live workloads, no node pressure, and at least 600MiB
  available in the Docker VM before starting.
- CPU containers are sequential with the OOM Pod; combined temporary Docker
  memory limits are 480MiB. No swap, persistent mounts, or published ports.
- Live traffic is bounded separately. Two observed live health failures stop
  further experiment stages; this is checked between bounded stages, not an
  instantaneous emergency brake. All live health samples must pass for success.
- Commands have timeouts; stage checks enforce a five-minute run budget. Cleanup
  may take longer. Ctrl+C requests cleanup after the current bounded operation.
- Cleanup validates exact generated names and run labels and rejects persistent
  mounts. It continues attempting other owned resources when one cleanup fails.
- A hard process kill or Docker/cluster outage can prevent cleanup. Inspect the
  run report and owned resources before removing a stale lock; never prune the
  cluster or delete database volumes to recover a drill.
- Initial attempt `resources-2026-09-24T07-55-50-961Z-05eab6ed` exposed absent
  optional Docker `Tmpfs` fields. Its failure evidence remains on E:, and its
  report records verified follow-up cleanup. The inspect handling is corrected.

No production metrics backend, alert, HPA, sustained capacity test, or heap
profiling system was added. The load generator is deliberately bounded and is
not a general-purpose benchmarking replacement.

## Official references

1. https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
2. https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
3. https://docs.docker.com/engine/containers/resource_constraints/
4. https://nodejs.org/docs/latest-v24.x/api/process.html
5. https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/
