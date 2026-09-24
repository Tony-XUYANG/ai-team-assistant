const { createServer } = require("./app");
const { log, safeErrorCode } = require("./logger");
const database = require("./database");

const port = Number(process.env.PORT || 8000);
const server = createServer({ database });

database.initialize().then(() => {
  server.listen(port, "0.0.0.0", () => {
    log("info", "server_started", { port });
  });
}).catch(async (error) => {
  log("error", "startup_failed", { dependency: "postgresql", errorCode: safeErrorCode(error) });
  try { await database.close(); } finally { process.exit(1); }
});

server.on("error", error => {
  log("error", "server_error", { errorCode: safeErrorCode(error) });
  process.exit(1);
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("info", "shutdown_started", { signal });
  const timer = setTimeout(() => {
    log("error", "shutdown_timeout");
    process.exit(1);
  }, 8000);
  timer.unref();
  server.close(async () => {
    try {
      await database.close();
      clearTimeout(timer);
      log("info", "shutdown_completed");
      process.exit(0);
    } catch (error) {
      log("error", "shutdown_failed", { errorCode: safeErrorCode(error) });
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
