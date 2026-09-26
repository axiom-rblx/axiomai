const APP_PATH = /^\/(?:chat(?:\/[^/]+)?|studio|devhub|creations|messages|notifications|groups|updates|@[^/]+)\/?$/;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Assets canonicalizes /index.html to / with a 307; fetch the root asset
    // directly so deep chat links keep their URL and return HTTP 200.
    if (APP_PATH.test(url.pathname)) url.pathname = '/';
    // /benchmark serves benchmark/index.html directly, without a trailing-slash redirect.
    if (url.pathname === '/benchmark') url.pathname = '/benchmark/';
    let response = await env.ASSETS.fetch(new Request(url, request));
    // Unknown pages get the Axiom 404 page (with a real 404 status) instead of
    // an empty response. "/404" is used because assets redirect "/404.html" there.
    if (response.status === 404 && (request.method === 'GET' || request.method === 'HEAD')) {
      const page = await env.ASSETS.fetch(new Request(new URL('/404', url), { method: request.method }));
      if (page.ok) response = new Response(page.body, { status: 404, headers: page.headers });
    }
    const headers = new Headers(response.headers);
    headers.set('X-Axiom-Release', '14.2.0');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // No other site may load Axiom inside a frame (stops clickjacking of the signed-in app).
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    headers.set('Strict-Transport-Security', 'max-age=31536000');
    if (headers.get('Content-Type')?.includes('text/html')) headers.set('Cache-Control', 'no-cache');
    return new Response(response.body, { status: response.status, headers });
  }
};
