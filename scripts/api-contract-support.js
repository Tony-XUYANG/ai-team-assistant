const assert = require("node:assert/strict");
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const contract = require("../api/openapi.json");

function createContractValidator() {
  const ajv = new Ajv({ allErrors: true, strictRequired: false });
  addFormats(ajv);
  // OpenAPI references resolve through components, outside the schema vocabulary.
  ajv.addKeyword("components");
  const validators = new Map();
  function check(schema, value) {
    const key = JSON.stringify(schema);
    if (!validators.has(key)) validators.set(key, ajv.compile({
      ...schema, components: { schemas: contract.components.schemas },
    }));
    const validate = validators.get(key);
    assert.ok(validate(value), ajv.errorsText(validate.errors));
  }
  function schema(name, value) {
    assert.ok(Object.hasOwn(contract.components.schemas, name), "Unknown contract schema");
    check({ $ref: `#/components/schemas/${name}` }, value);
  }
  function response(sample) {
    const operation = contract.paths[sample.path]?.[sample.method.toLowerCase()];
    assert.ok(operation, "Undocumented API operation");
    let expected = operation.responses[String(sample.status)];
    assert.ok(expected, "Undocumented HTTP status");
    if (expected.$ref) expected = contract.components.responses[expected.$ref.split("/").at(-1)];
    check(expected.content["application/json"].schema, sample.body);
    for (const [name, definition] of Object.entries(expected.headers)) {
      check(definition.schema, sample.headers[name.toLowerCase()]);
    }
    assert.match(sample.headers["content-type"], /^application\/json\b/);
    if (sample.status >= 400) assert.equal(sample.body.request_id, sample.headers["x-request-id"]);
  }
  return { schema, response };
}

module.exports = { createContractValidator };
