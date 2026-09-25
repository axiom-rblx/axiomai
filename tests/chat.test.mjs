import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, robloxStaticAudit } from '../worker.js';

test('Roblox validator catches a jump counter that increments on both event edges', () => {
  const broken = 'humanoid.Jumping:Connect(function() jumpCount += 1 end)';
  assert.match(robloxStaticAudit(broken).join(' '), /both jump start and stop/);
  assert.deepEqual(robloxStaticAudit('humanoid.Jumping:Connect(function(active) if active then jumpCount += 1 end end)'), []);
});

test('chat repairs a bad Roblox script before answering', async () => {
  const bad = '```luau\nhumanoid.Jumping:Connect(function() jumpCount += 1 end)\n```';
  const good = '```luau\nhumanoid.Jumping:Connect(function(active) if active then jumpCount += 1 end end)\n```';
  const calls = [];
  const env = { AI: { run: async (model, input) => {
    calls.push({ model, input });
    return { response: calls.length === 1 ? bad : good };
  } } };
  const request = new Request('https://axiom-proxy.example/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_profile: 'sol', workspace: 'code', stream: false,
      messages: [{ role: 'user', content: 'Write a short Roblox server script that resets my character after jumping five times.' }] })
  });
  const response = await chat(request, env, {}, null, { waitUntil() {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(JSON.stringify(body), /function\(active\)/);
  assert.ok(calls.length >= 2, 'Axiom should repair the initial bad draft');
  assert.match(JSON.stringify(calls.at(-1).input.messages), /both jump start and stop/);
});
