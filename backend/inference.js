// Axiom owns routing, memory and validation. These are open base models until an
// evaluated Axiom adapter or a private inference endpoint is explicitly configured.
export const CODING_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';
export const VISION_MODEL = '@cf/qwen/qwen3.8-27b';
const BACKUP_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export class InferenceError extends Error {
  constructor(status, code, message, retry = 0) {
    super(message);
    this.name = 'InferenceError';
    this.status = status;
    this.code = code;
    if (retry > 0) this.retry = retry;
  }
}

export function inferenceInfo(env) {
  const privateEndpoint = !!env.AXIOM_INFERENCE_URL;
  return {
    configured: privateEndpoint ? !!env.AXIOM_INFERENCE_TOKEN : !!env.AI,
    runtime: privateEndpoint ? 'axiom-private' : 'workers-ai',
    baseModel: privateEndpoint ? String(env.AXIOM_MODEL_ID || 'axiom-sol') : String(env.AXIOM_BASE_MODEL || CODING_MODEL),
    trainingStatus: privateEndpoint ? 'external-checkpoint' : (env.AXIOM_SOL_ADAPTER || env.AXIOM_TERRA_ADAPTER ? 'adapter-configured' : 'base-model'),
  };
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(3600, Math.ceil(seconds)));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(3600, Math.ceil((date - now) / 1000))) : 0;
}

function abortError() { return new DOMException('Request cancelled', 'AbortError'); }
function textFrom(result) {
  const value = result?.choices?.[0]?.message?.content ?? result?.response ?? result?.message?.content;
  if (typeof value !== 'string' || !value.trim()) throw new InferenceError(502, 'EMPTY_OUTPUT', 'Axiom received an empty response. Retry this message.');
  // Older reasoning models occasionally embed private analysis in the text field.
  return value.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

export function classifyInferenceError(error) {
  if (error?.name === 'AbortError' || error instanceof InferenceError) return error;
  const message = String(error?.message || '');
  const code = Number(error?.code || error?.internalCode || message.match(/\b(30\d\d|50\d\d)\b/)?.[1]);
  if (code === 3036 || /daily.*allocation|quota.*exceed/i.test(message)) {
    return new InferenceError(503, 'CAPACITY_EXHAUSTED', 'Axiom’s inference allocation is exhausted. The owner needs to add capacity; retrying immediately will not help. Your message is saved.');
  }
  if ([5016,5018,5035,3041,3023,5007,3042].includes(code) || /not allowed|paid plan|no such model|unauthorized/i.test(message)) {
    return new InferenceError(503, 'INFERENCE_CONFIGURATION', 'Axiom’s model is unavailable for this deployment. The owner needs to check the inference configuration. Your message is saved.');
  }
  if (code === 3006 || /context.*(?:exceed|length)|too large|maximum.*tokens/i.test(message)) {
    return new InferenceError(413, 'CONTEXT_TOO_LARGE', 'This request exceeds the active model’s context window. Split the code into files or start a focused chat.');
  }
  if (code === 3040 || Number(error?.status) === 429 || /capacity|busy|rate.?limit/i.test(message)) {
    return new InferenceError(503, 'MODEL_BUSY', 'Axiom’s inference service is busy. Your message is saved.', 15);
  }
  return new InferenceError(502, 'INFERENCE_UNAVAILABLE', 'Axiom could not finish the response. Your message is saved; please retry.');
}

async function privateInference(env, payload, signal, route) {
  let url;
  try { url = new URL(env.AXIOM_INFERENCE_URL); } catch { throw new InferenceError(503,'INFERENCE_CONFIGURATION','The private inference endpoint is not configured correctly.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !env.AXIOM_INFERENCE_TOKEN) {
    throw new InferenceError(503,'INFERENCE_CONFIGURATION','Private inference requires an HTTPS endpoint and a server-side access token.');
  }
  const model = route.modelProfile === 'terra' ? env.AXIOM_TERRA_MODEL_ID || env.AXIOM_MODEL_ID : env.AXIOM_MODEL_ID;
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.AXIOM_INFERENCE_TOKEN },
    body: JSON.stringify({
      model: model || 'axiom-sol', messages: payload.messages, stream: false,
      max_tokens: Math.min(8192, Number(payload.max_completion_tokens || 4096)), temperature: 0.3
    })
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429 || response.status === 503) throw new InferenceError(503,'MODEL_BUSY','Axiom’s private inference server is busy. Your message is saved.',parseRetryAfter(response.headers.get('Retry-After')) || 15);
    if (response.status === 413) throw new InferenceError(413,'CONTEXT_TOO_LARGE','The attached context is too large for the active model. Split the source into smaller files.');
    throw new InferenceError(502,'INFERENCE_UNAVAILABLE','The private inference server could not complete this request. Your message is saved.');
  }
  // Bound memory even if a private server is misconfigured.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new InferenceError(502,'OUTPUT_TOO_LARGE','The inference server returned an oversized response.');
      body += decoder.decode(value, {stream:true});
    }
    return textFrom(JSON.parse(body + decoder.decode()));
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

async function cloudInference(env, payload, signal, route, backup = false) {
  const visual = payload.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
  const model = visual ? (env.AXIOM_VISION_MODEL || VISION_MODEL) : backup ? BACKUP_MODEL : (env.AXIOM_BASE_MODEL || CODING_MODEL);
  const adapter = route.modelProfile === 'terra' ? env.AXIOM_TERRA_ADAPTER : env.AXIOM_SOL_ADAPTER;
  const maxTokens = Math.max(256, Math.min(8192, Number(payload.max_completion_tokens || 4096)));
  const input = {
    messages: payload.messages, stream: false, temperature: 0.3,
    ...(model.includes('qwen3.8') ? {max_completion_tokens:maxTokens,reasoning_effort:'low'} : {max_tokens:maxTokens}),
    ...(!visual && !backup && adapter ? {lora:String(adapter)} : {})
  };
  return textFrom(await env.AI.run(model, input, { signal }));
}

export async function generateCompletion(env, payload, signal, route = {}) {
  if (signal?.aborted) throw abortError();
  const info = inferenceInfo(env);
  if (!info.configured) throw new InferenceError(503,'INFERENCE_CONFIGURATION','Axiom inference is not configured. Your message is saved.');
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, {once:true});
  const timer = setTimeout(() => controller.abort('timeout'), 120000);
  const started = Date.now();
  try {
    let answer;
    try {
      answer = info.runtime === 'axiom-private'
        ? await privateInference(env,payload,controller.signal,route)
        : await cloudInference(env,payload,controller.signal,route);
    } catch (raw) {
      if (controller.signal.aborted) throw abortError();
      const error = classifyInferenceError(raw);
      const textOnly = !payload.messages.some(m => Array.isArray(m.content));
      // A second model helps with model-specific capacity, never an exhausted
      // account allocation. Private prompts stay private unless fallback is opted in.
      const allowCloud = info.runtime === 'workers-ai' || env.AXIOM_ALLOW_CLOUD_FALLBACK === 'true';
      if (env.AI && allowCloud && textOnly && ['MODEL_BUSY','INFERENCE_UNAVAILABLE','EMPTY_OUTPUT'].includes(error.code)) {
        answer = await cloudInference(env,payload,controller.signal,route,true).catch(e=>{throw classifyInferenceError(e);});
      } else throw error;
    }
    console.log('[Axiom inference]',JSON.stringify({runtime:info.runtime,role:route.role||'builder',durationMs:Date.now()-started,outputChars:answer.length}));
    return answer;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (controller.signal.aborted) throw new InferenceError(504,'INFERENCE_TIMEOUT','Axiom took too long to generate this response. Your message is saved; please retry.');
    throw classifyInferenceError(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',forwardAbort);
  }
}
