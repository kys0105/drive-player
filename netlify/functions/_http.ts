export function privateResponse(
  body: ConstructorParameters<typeof Response>[0] = null,
  status = 200,
  extraHeaders?: ConstructorParameters<typeof Headers>[0]
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('CDN-Cache-Control', 'no-store');
  headers.set('Netlify-CDN-Cache-Control', 'no-store');
  headers.set('Vercel-CDN-Cache-Control', 'no-store');
  headers.set('Vary', 'Cookie, Origin, Range');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(body, { status, headers });
}

export function jsonResponse(
  value: unknown,
  status = 200,
  headers?: ConstructorParameters<typeof Headers>[0]
): Response {
  const out = new Headers(headers);
  out.set('Content-Type', 'application/json; charset=utf-8');
  return privateResponse(JSON.stringify(value), status, out);
}

export function methodNotAllowed(allow: string): Response {
  return privateResponse('Method not allowed', 405, { Allow: allow });
}

export function rejectCrossOrigin(req: Request, requireOrigin = false): Response | null {
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (
    (requireOrigin && !origin) ||
    (origin !== null && origin !== new URL(req.url).origin) ||
    (site !== null && site !== 'same-origin' && site !== 'none')
  ) {
    return privateResponse('Forbidden', 403);
  }
  return null;
}
