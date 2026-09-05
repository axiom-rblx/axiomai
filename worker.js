// Axiom Groq Proxy — Cloudflare Worker
//
// This keeps your Groq API key OUT of the public website entirely.
// The key lives only here, as a Worker secret, never in any file you commit.
//
// SETUP (one-time, ~5 minutes):
// 1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
// 2. Name it something like "axiom-proxy", then click "Deploy" to create it with default code.
// 3. Click "Edit code" and replace everything with this file's contents.
// 4. Click "Deploy" again to save.
// 5. Go to Settings -> Variables and Secrets -> Add -> name it GROQ_API_KEY,
//    paste your (NEW, rotated) Groq key as the value, mark it "Encrypt", save.
// 6. Copy your worker's URL (looks like https://axiom-proxy.<your-subdomain>.workers.dev)
// 7. In index.html, set PROXY_URL to that address instead of calling Groq directly.
//
// Optional but recommended: under Settings -> Triggers, you can later add a custom
// domain/route so requests go through axiomai.technology/api instead of workers.dev.

export default {
  async fetch(request, env) {
    // CORS headers so your site (any origin, tighten this once live if you want)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: "Invalid JSON body" } }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Basic guardrails: cap tokens, only allow the two models Axiom uses
    const allowedModels = ["openai/gpt-oss-120b", "qwen/qwen3.6-27b"];
    if (!allowedModels.includes(body.model)) {
      return new Response(JSON.stringify({ error: { message: "Model not allowed" } }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    body.max_tokens = Math.min(body.max_tokens || 4096, 4096);

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.GROQ_API_KEY,
      },
      body: JSON.stringify(body),
    });

    const data = await groqRes.text();
    return new Response(data, {
      status: groqRes.status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  },
};
