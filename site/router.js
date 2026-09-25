const APP_PATH = /^\/(?:chat(?:\/[^/]+)?|devhub|creations|messages|notifications|groups|updates|@[^/]+)\/?$/;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Assets canonicalizes /index.html to / with a 307; fetch the root asset
    // directly so deep chat links keep their URL and return HTTP 200.
    if (APP_PATH.test(url.pathname)) url.pathname = '/';
    const response = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(response.headers);
    headers.set('X-Axiom-Release', '13.1.0');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (headers.get('Content-Type')?.includes('text/html')) headers.set('Cache-Control', 'no-cache');
    return new Response(response.body, { status: response.status, headers });
  }
};
