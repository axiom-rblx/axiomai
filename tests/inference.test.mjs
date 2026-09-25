import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODING_MODEL, InferenceError, generateCompletion, inferenceInfo,
  parseRetryAfter, classifyInferenceError
} from '../backend/inference.js';

const messages = [{ role: 'user', content: 'Write a Roblox server script.' }];
const payload = { messages, max_completion_tokens: 1200 };

test('reports the actual base-model status, never a trained checkpoint', () => {
  assert.deepEqual(inferenceInfo({ AI: {} }), {
    configured: true, runtime: 'workers-ai', baseModel: CODING_MODEL,
    trainingStatus: 'base-model'
  });
  assert.equal(inferenceInfo({ AI: {}, AXIOM_SOL_ADAPTER: 'adapter-id' }).trainingStatus, 'adapter-configured');
  assert.equal(inferenceInfo({ AXIOM_INFERENCE_URL: 'https://inference.example' }).configured, false);
});

test('calls the coding model and respects the requested output budget', async () => {
  const calls = [];
  const env = { AI: { run: async (...args) => {
    calls.push(args);
    return { response: '```luau\nprint("ready")\n```' };
  } } };
  const answer = await generateCompletion(env, payload, undefined, { modelProfile: 'sol' });
  assert.match(answer, /print\("ready"\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], CODING_MODEL);
  assert.equal(calls[0][1].max_tokens, 1200);
  assert.equal(calls[0][1].messages, messages);
});

test('temporary model congestion falls back, account quota does not', async () => {
  const calls = [];
  const env = { AI: { run: async model => {
    calls.push(model);
    if (calls.length === 1) throw Object.assign(new Error('model busy'), { code: 3040 });
    return { response: 'A working answer' };
  } } };
  assert.equal(await generateCompletion(env, payload), 'A working answer');
  assert.equal(calls.length, 2);

  let quotaCalls = 0;
  const quotaEnv = { AI: { run: async () => {
    quotaCalls++;
    throw Object.assign(new Error('daily allocation exhausted'), { code: 3036 });
  } } };
  await assert.rejects(generateCompletion(quotaEnv, payload), e => e instanceof InferenceError && e.code === 'CAPACITY_EXHAUSTED');
  assert.equal(quotaCalls, 1);
});

test('maps provider errors into actionable messages', () => {
  assert.equal(classifyInferenceError({ code: 3006 }).status, 413);
  assert.equal(classifyInferenceError({ status: 429 }).code, 'MODEL_BUSY');
  assert.equal(parseRetryAfter('29'), 29);
  assert.equal(parseRetryAfter('Fri, 25 Sep 2026 00:00:30 GMT', Date.parse('Fri, 25 Sep 2026 00:00:00 GMT')), 30);
});

test('rejects missing runtime and supports an authenticated private endpoint', async () => {
  await assert.rejects(generateCompletion({}, payload), e => e.code === 'INFERENCE_CONFIGURATION');
  const formerFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  try {
    const env = { AXIOM_INFERENCE_URL: 'https://inference.example/v1/chat/completions', AXIOM_INFERENCE_TOKEN: 'local-secret' };
    assert.equal(await generateCompletion(env, payload), 'ok');
  } finally {
    globalThis.fetch = formerFetch;
  }
});
