// Axiom Groq Proxy + DevHub — Cloudflare Worker
//
// This keeps your Groq API key OUT of the public website entirely.
// The key lives only here, as a Worker secret, never in any file you commit.
// It also powers DevHub: a simple shared chat board using Cloudflare KV.
//
// SETUP (one-time, ~5 minutes):
// 1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
// 2. Name it something like "axiom-proxy", then click "Deploy" to create it with default code.
// 3. Click "Edit code" and replace everything with this file's contents.
// 4. Click "Deploy" again to save.
// 5. Go to Settings -> Variables and Secrets -> Add -> name it GROQ_API_KEY,
//    paste your Groq key as the value, mark it "Encrypt", save.
// 6. For DevHub: go to Storage & Databases -> KV -> Create a namespace (e.g. "axiom_devhub").
//    Then in your Worker's Settings -> Bindings -> Add binding -> KV Namespace,
//    set variable name to DEVHUB_KV and select that namespace.
// 7. Copy your worker's URL (looks like https://axiom-proxy.<your-subdomain>.workers.dev)
// 8. In index.html, PROXY_URL should already point here for chat; DevHub calls
//    the same URL with a different path (/devhub).

const DEVHUB_KEY = "devhub_messages";
const DEVHUB_MAX_MESSAGES = 200;

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    /* ---------- DevHub: shared chat board via KV ---------- */
    if (url.pathname === "/devhub") {
      if (!env.DEVHUB_KV) {
        return new Response(JSON.stringify({ error: { message: "DevHub KV binding not configured yet." } }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (request.method === "GET") {
        const raw = await env.DEVHUB_KV.get(DEVHUB_KEY);
        const messages = raw ? JSON.parse(raw) : [];
        return new Response(JSON.stringify({ messages }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch (e) {
          return new Response(JSON.stringify({ error: { message: "Invalid JSON" } }), {
            status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        const name = (body.name || "Anonymous").toString().slice(0, 40);
        const text = (body.text || "").toString().slice(0, 500);
        const color = (body.color || "#2f7bff").toString().slice(0, 20);
        if (!text.trim()) {
          return new Response(JSON.stringify({ error: { message: "Empty message" } }), {
            status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const raw = await env.DEVHUB_KV.get(DEVHUB_KEY);
        const messages = raw ? JSON.parse(raw) : [];
        messages.push({ name, text, color, ts: Date.now() });
        while (messages.length > DEVHUB_MAX_MESSAGES) messages.shift();
        await env.DEVHUB_KV.put(DEVHUB_KEY, JSON.stringify(messages));

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    /* ---------- Groq chat proxy ---------- */
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
