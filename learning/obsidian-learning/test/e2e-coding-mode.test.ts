import assert from "node:assert/strict";
import { test } from "node:test";
import { makeVault } from "./helpers/vault.ts";
import { openSession, ai } from "./helpers/session.mjs";

test("coding defaults on and toggles tools and tutoring for the current session", async () => {
 const tv = makeVault();
 const h = await openSession(tv, { coding: true });
 try {
  const tools = () => h.session.getActiveToolNames();
  assert.ok(tools().includes("bash"));
  await h.run("hello", [(ctx) => {
   assert.doesNotMatch(ctx.systemPrompt, /never give the complete solution first/);
   return ai.fauxAssistantMessage("Hello.");
  }]);
  await h.session.prompt("/coding off");
  assert.ok(!tools().includes("bash"));
  await h.run("teach", [(ctx) => {
   assert.match(ctx.systemPrompt, /never give the complete solution first/);
   return ai.fauxAssistantMessage("Learning.");
  }]);
  await h.session.prompt("/coding on");
  assert.ok(tools().includes("bash"));
  await h.session.prompt("/coding");
  assert.ok(!tools().includes("bash"));
  await h.session.prompt("/coding invalid");
  assert.ok(!tools().includes("bash"));
  await h.session.prompt("/coding on");
  h.session.setActiveToolsByName(tools().filter(t => t !== "bash"));
  await h.session.prompt("/coding off");
  await h.session.prompt("/coding on");
  assert.ok(!tools().includes("bash"), "previously disabled tools stay disabled");
  assert.deepEqual(h.errors, []);
 } finally { await h.close(); tv.cleanup(); }
});
