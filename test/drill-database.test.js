const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeEndpoints } = require("../scripts/drill-database");

test("empty database EndpointSlices accept absent, null, and empty endpoints", () => {
  assert.deepEqual(summarizeEndpoints({ items: [] }), []);
  assert.deepEqual(summarizeEndpoints({ items: [{}, { endpoints: null }, { endpoints: [] }] }), []);
});

test("readiness evidence retains both ready and unready endpoints", () => {
  const endpoints = [
    { addresses: ["10.0.0.1"], conditions: { ready: false } },
    { addresses: ["10.0.0.2"], conditions: { ready: true } },
    { addresses: ["10.0.0.3"], conditions: {} },
    { addresses: ["10.0.0.4"] },
    { addresses: ["10.0.0.5"], conditions: { ready: null } },
  ];
  assert.deepEqual(summarizeEndpoints({ items: [{ endpoints }] }).map(item => item.ready),
    [false, true, true, true, true]);
});

test("malformed API output is not mistaken for an empty endpoint list", () => {
  assert.throws(() => summarizeEndpoints({}), /EndpointSlice list/);
});
