import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
  DUMMY_PASSWORD_HASH,
  verifyPassword,
} from "../../../apps/api/src/modules/identity/password-hasher.ts";
import { isTransferableLegacyPassword } from "./native-transition.mts";

test("allows canonical accepted-policy Legacy PHC without converting its bytes", async () => {
  const password = "  disposable Legacy password é🔒  ";
  const encoded = await hashPassword(password);
  const alternate = encoded.replace(
    /\$m=65536,(?:t=3,p=4|p=4,t=3)\$/,
    encoded.includes("$m=65536,t=3,p=4$")
      ? "$m=65536,p=4,t=3$"
      : "$m=65536,t=3,p=4$",
  );
  assert.equal(alternate !== encoded, true);
  for (const value of [encoded, alternate]) {
    assert.equal(isTransferableLegacyPassword(value), true);
    assert.equal(await verifyPassword(value, password), true);
  }
  for (const incompatible of [
    encoded.replace("argon2id", "argon2i"),
    encoded.replace("v=19", "v=16"),
    encoded.replace("m=65536", "m=32768"),
    encoded.replace("t=3", "t=2"),
    encoded.replace("p=4", "p=1"),
    `${encoded}=`,
    ` ${encoded}`,
    encoded.replace("m=65536", "m=65536,m=65536"),
    encoded.slice(0, -1),
  ])
    assert.equal(isTransferableLegacyPassword(incompatible), false);
});

test("refuses both public dummy verifiers and absent or malformed material", () => {
  for (const value of [
    DUMMY_PASSWORD_HASH,
    "$argon2id$v=19$m=65536,p=4,t=3$MELWslgkJzw87Me69Wz1tw$l9XoBv1UBhpmS40M2xzT5cHzqoSubftPd1Md5u/ZmvQ",
    "",
    "not-a-credential",
    "$argon2id$v=19$m=65536,t=3,p=4$invalid$invalid",
  ])
    assert.equal(isTransferableLegacyPassword(value), false);
});

test("refuses the equivalent reordered Legacy dummy identity", () => {
  const reordered = DUMMY_PASSWORD_HASH.replace(
    "m=65536,p=4,t=3",
    "m=65536,t=3,p=4",
  );
  assert.equal(reordered !== DUMMY_PASSWORD_HASH, true);
  assert.equal(isTransferableLegacyPassword(reordered), false);
});

test("refuses the equivalent reordered Native dummy identity", () => {
  const reordered =
    "$argon2id$v=19$m=65536,t=3,p=4$MELWslgkJzw87Me69Wz1tw$l9XoBv1UBhpmS40M2xzT5cHzqoSubftPd1Md5u/ZmvQ";
  assert.equal(isTransferableLegacyPassword(reordered), false);
});
