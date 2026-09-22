import assert from "node:assert/strict";
import { test } from "node:test";
import { diffMembers, resolveMembers, normalizeEmail } from "../src/reconcile.js";

test("diffMembers computes minimal add/remove", () => {
  const d = diffMembers(["a", "b", "c"], ["b", "c", "d"]);
  assert.deepEqual(d.add.sort(), ["d"]);
  assert.deepEqual(d.remove.sort(), ["a"]);
});

test("diffMembers on equal sets is a no-op (idempotent sync)", () => {
  const d = diffMembers(["x", "y"], ["y", "x"]);
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, []);
});

test("resolveMembers maps external ids to user ids, skipping unknowns", () => {
  const map = new Map([["ext1", "u1"], ["ext2", "u2"]]);
  assert.deepEqual(resolveMembers(["ext1", "ext-missing", "ext2"], map), ["u1", "u2"]);
});

test("normalizeEmail lowercases and trims", () => {
  assert.equal(normalizeEmail("  Alice@Example.COM "), "alice@example.com");
});
