const test = require("node:test");
const assert = require("node:assert/strict");
test("intentional CI failure: publication must not happen", () => {
  assert.fail("Deliberate local CI gate drill");
});
