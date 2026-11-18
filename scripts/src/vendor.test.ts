import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import AjvModule from "ajv/dist/2020.js";
import { parse } from "yaml";

const Ajv2020 = AjvModule.default;
const root = resolve(import.meta.dirname, "../..");
const vendor = join(root, "contracts/vendor");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

function envelope() {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const dir = join(vendor, "schemas");
  for (const f of readdirSync(dir)) ajv.addSchema(json(join(dir, f)));
  const validate = ajv.getSchema(
    "https://github.com/basics-only/bae6-contracts/schemas/error-envelope.json",
  );
  assert.ok(validate);
  return validate;
}

test("vendors bae6-contracts v0.1.0", () => {
  assert.equal(readFileSync(join(vendor, "VERSION"), "utf8").trim(), "v0.1.0");
});

test("authz error bodies conform to the shared bae6 error envelope", () => {
  const valid = envelope();
  const spec = parse(
    readFileSync(join(root, "contracts/openapi.yaml"), "utf8"),
  );
  const bodies: unknown[] = Object.values(
    spec.components.responses.Error.content["application/json"].examples,
  ).map((e) => (e as { value: unknown }).value);
  const cases = join(root, "tests/conformance/cases");
  for (const f of readdirSync(cases)) {
    const c = json(join(cases, f));
    if (c.response.status >= 400 && !c.nonconformingResponse) {
      bodies.push(c.response.body);
    }
  }
  assert.ok(bodies.length > 5);
  for (const body of bodies) assert.ok(valid(body), JSON.stringify(body));
});

test("rejects an error body with a missing or malformed request id", () => {
  const valid = envelope();
  assert.equal(valid({ code: "forbidden", message: "No." }), false);
  assert.equal(
    valid({ code: "forbidden", message: "No.", requestId: "has space" }),
    false,
  );
});
