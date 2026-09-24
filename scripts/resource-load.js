const http = require("node:http");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { validateLoad, summarizeLoad } = require("./resource-support");

function oneRequest(url, { agent, timeoutMs, expectedLocation }) {
  return new Promise(resolve => {
    const started = performance.now();
    let done = false;
    let timer;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: performance.now() - started });
    };
    const request = http.get(url, { agent }, response => {
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 32768) request.destroy(new Error("response-too-large"));
      });
      response.once("end", () => finish({ status: response.statusCode,
        ...(expectedLocation && response.headers.location !== expectedLocation ? { error: "wrong-location" } : {}) }));
      response.once("aborted", () => finish({ error: "response-aborted" }));
      response.once("error", () => finish({ error: "response-error" }));
    });
    request.once("error", error => finish({ error: error.message === "request-timeout" ? "timeout" : "network-error" }));
    timer = setTimeout(() => request.destroy(new Error("request-timeout")), timeoutMs);
  });
}

async function measure(options) {
  validateLoad(options);
  const agent = new http.Agent({ keepAlive: true, maxSockets: options.concurrency, maxFreeSockets: options.concurrency });
  const samples = [];
  const pending = new Set();
  const intervalMs = 1000 / options.rate;
  const planned = Math.ceil(options.durationMs / intervalMs);
  let droppedBusy = 0;
  let droppedLate = 0;
  let maxLagMs = 0;
  const started = performance.now();
  try {
    for (let slot = 0; slot < planned; slot++) {
      const due = started + slot * intervalMs;
      while (performance.now() < due) await delay(Math.max(1, due - performance.now()));
      const lag = performance.now() - due;
      maxLagMs = Math.max(maxLagMs, lag);
      // Missed arrivals are counted, not replayed as an artificial burst.
      if (lag >= intervalMs) { droppedLate++; continue; }
      if (pending.size >= options.concurrency) { droppedBusy++; continue; }
      const task = oneRequest(options.baseUrl + options.route, { ...options, agent })
        .then(sample => samples.push({ slot, ...sample })).finally(() => pending.delete(task));
      pending.add(task);
    }
    await delay(Math.max(0, started + options.durationMs - performance.now()));
    await Promise.all(pending);
    return { options, summary: summarizeLoad(samples, { expectedStatus: options.expectedStatus, planned, droppedBusy,
      droppedLate, elapsedMs: performance.now() - started, offeredMs: options.durationMs, maxLagMs }), samples };
  } finally { agent.destroy(); }
}

if (require.main === module) {
  const guard = setTimeout(() => process.exit(2), 15000);
  measure(JSON.parse(process.argv[2])).then(result => {
    clearTimeout(guard);
    console.log(JSON.stringify(result));
  }).catch(error => { clearTimeout(guard); console.error(error.message); process.exitCode = 1; });
}

module.exports = { measure };
