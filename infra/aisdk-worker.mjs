const issuer = "https://token.actions.githubusercontent.com";
const audience = "https://urban-couscous.ai-sdk.pro";
const decoder = new TextDecoder();
const validPath = path => path.length <= 240 && path.split("/").every(part => /^[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]*$/.test(part));
const mime = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "application/javascript", mjs: "application/javascript", svg: "image/svg+xml", png: "image/png", webp: "image/webp", jpg: "image/jpeg", ico: "image/x-icon", woff2: "font/woff2", json: "application/json" };
const bytes = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));

async function verifiedCommit(request, env) {
  try {
    const jwt = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_.-]{1,10000})$/)?.[1];
    const parts = jwt?.split(".");
    if (parts?.length !== 3) return null;
    const [header, claims, signature] = parts;
    const { alg, kid } = JSON.parse(decoder.decode(bytes(header)));
    if (alg !== "RS256" || typeof kid !== "string") return null;
    const response = await fetch(issuer + "/.well-known/jwks", { cf: { cacheEverything: true, cacheTtl: 300 } });
    if (!response.ok) return null;
    const { keys } = await response.json();
    const jwk = keys.find(key => key.kid === kid && key.kty === "RSA" && key.use === "sig");
    if (!jwk) return null;
    const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
    if (!await crypto.subtle.verify(algorithm, key, bytes(signature), new TextEncoder().encode(header + "." + claims))) return null;
    const c = JSON.parse(decoder.decode(bytes(claims)));
    const now = Math.floor(Date.now() / 1000);
    if (c.iss !== issuer || c.aud !== audience || !Number.isInteger(c.nbf) || !Number.isInteger(c.exp) ||
        c.nbf > now + 30 || c.exp <= now || c.repository_id !== env.GITHUB_REPOSITORY_ID ||
        c.repository !== env.GITHUB_REPOSITORY || c.ref !== "refs/heads/main" ||
        !["push", "workflow_dispatch"].includes(c.event_name) ||
        c.workflow_ref !== env.GITHUB_REPOSITORY + "/.github/workflows/aisdk-deploy.yml@refs/heads/main" ||
        c.workflow_sha !== c.sha || !/^[a-f0-9]{40}$/.test(c.sha)) return null;
    return c.sha;
  } catch {
    return null;
  }
}

async function deploy(request, env) {
  const commit = await verifiedCommit(request, env);
  if (!commit) return new Response("Unauthorized", { status: 401 });
  const maxBody = 8 * 1024 * 1024;
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxBody) return new Response("Invalid upload size", { status: 413 });
  let files;
  try {
    files = JSON.parse(await request.text());
    if (!files || Array.isArray(files) || typeof files !== "object" || typeof files["index.html"] !== "string") throw Error();
    const entries = Object.entries(files);
    if (entries.length > 300 || entries.some(([path, data]) => !validPath(path) || typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) throw Error();
    files = entries.map(([path, data]) => [path, bytes(data)]);
  } catch {
    return new Response("Invalid build artifact", { status: 422 });
  }
  const release = commit + "-" + crypto.randomUUID();
  for (const [path, data] of files) await env.SITES.put(`releases/${release}/${path}`, data);
  await env.SITES.put("current", release);
  return Response.json({ commit, url: audience + "/" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== audience) return new Response("Not found", { status: 404 });
    if (url.pathname === "/_aisdk/deploy" && request.method === "POST") return deploy(request, env);
    if (url.pathname.startsWith("/_aisdk/")) {
      if (url.pathname !== "/_aisdk/status" || request.method !== "GET") return new Response("Not found", { status: 404 });
      const current = await env.SITES.get("current");
      return Response.json({ commit: current ? (await current.text()).slice(0, 40) : null }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
    let path;
    try { path = decodeURIComponent(url.pathname.slice(1)) || "index.html"; } catch { return new Response("Not found", { status: 404 }); }
    if (!validPath(path)) return new Response("Not found", { status: 404 });
    const pointer = await env.SITES.get("current");
    const release = pointer && await pointer.text();
    if (!release || !/^[a-f0-9]{40}-[a-f0-9-]{36}$/.test(release)) return new Response("Deployment pending", { status: 503 });
    const object = request.method === "HEAD" ? await env.SITES.head(`releases/${release}/${path}`) : await env.SITES.get(`releases/${release}/${path}`);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: { "Content-Type": mime[path.split(".").at(-1)] ?? "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" },
    });
  },
};
