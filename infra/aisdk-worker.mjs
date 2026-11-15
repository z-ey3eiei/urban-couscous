const issuer = "https://token.actions.githubusercontent.com";
const projectEndpoint = env => "https://registry.internal/projects/" + env.PROJECT_ID;
const decoder = new TextDecoder();
const validPath = path => path.length <= 240 && path.split("/").every(part => /^[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]*$/.test(part));
const mime = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "application/javascript", mjs: "application/javascript", svg: "image/svg+xml", png: "image/png", webp: "image/webp", jpg: "image/jpeg", ico: "image/x-icon", woff2: "font/woff2", json: "application/json", txt: "text/plain; charset=utf-8" };
const bytes = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));

async function verifiedCommit(request, project) {
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
    if (c.iss !== issuer || c.aud !== project.origin || !Number.isInteger(c.nbf) || !Number.isInteger(c.exp) ||
        c.nbf > now + 30 || c.exp <= now || c.repository_id !== project.repository_id ||
        c.repository !== project.repository || c.ref !== "refs/heads/" + project.branch ||
        !["push", "workflow_dispatch"].includes(c.event_name) ||
        c.workflow_ref !== project.repository + "/" + project.workflow + "@refs/heads/" + project.branch ||
        c.workflow_sha !== c.sha || !/^[a-f0-9]{40}$/.test(c.sha)) return null;
    const run = Number(c.run_number);
    const attempt = Number(c.run_attempt);
    if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(attempt) || attempt < 1) return null;
    return { commit: c.sha, run, attempt };
  } catch {
    return null;
  }
}

async function deploy(request, env, project) {
  const job = await verifiedCommit(request, project);
  if (!job) return new Response("Unauthorized", { status: 401 });
  if (!project.enabled) return new Response("Project disabled", { status: 403 });
  const { commit, run, attempt } = job;
  if (run === project.run_number && attempt === project.run_attempt && project.active_release?.startsWith(commit + "-")) {
    return Response.json({ commit, url: project.origin + "/" });
  }
  if (run < project.run_number || (run === project.run_number && attempt <= project.run_attempt)) {
    return new Response("Deployment superseded", { status: 409 });
  }
  const maxBody = 8 * 1024 * 1024;
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxBody) return new Response("Invalid upload size", { status: 413 });
  let files;
  try {
    files = JSON.parse(await request.text());
    if (!files || Array.isArray(files) || typeof files !== "object" || typeof files["index.html"] !== "string") throw Error();
    const entries = Object.entries(files);
    if (entries.length > 300 || entries.some(([path, data]) => !validPath(path) || typeof data !== "string" || (path !== "robots.txt" && (!Object.hasOwn(mime, path.split(".").at(-1)) || path.endsWith(".txt"))) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) throw Error();
    files = entries.map(([path, data]) => [path, bytes(data)]);
  } catch {
    return new Response("Invalid build artifact", { status: 422 });
  }
  const lease = crypto.randomUUID();
  const uploadEndpoint = projectEndpoint(env) + "/upload";
  const quota = await env.PROJECTS.fetch(uploadEndpoint, { method: "POST", body: JSON.stringify({ lease }) });
  if (!quota.ok) return new Response("Project upload limit reached", { status: quota.status === 429 ? 429 : 503 });
  const release = commit + "-" + lease;
  try {
    for (const [path, data] of files) await env.SITES.put(`releases/${release}/${path}`, data);
    return await env.PROJECTS.fetch(projectEndpoint(env), {
      method: "POST",
      body: JSON.stringify({ id: release, commit, run, attempt }),
    });
  } finally {
    await env.PROJECTS.fetch(uploadEndpoint, { method: "DELETE", body: JSON.stringify({ lease }) }).catch(() => {});
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== env.SITE_ORIGIN) return new Response("Not found", { status: 404 });
    if (url.pathname === "/_aisdk/deploy" && !request.headers.has("authorization")) return new Response("Unauthorized", { status: 401 });
    const registered = await env.PROJECTS.fetch(projectEndpoint(env));
    if (!registered.ok) return new Response("Project unavailable", { status: registered.status === 404 ? 404 : 503 });
    const project = await registered.json();
    if (!project.enabled) return new Response("Project disabled", { status: 403 });
    if (project.origin !== url.origin) return new Response("Not found", { status: 404 });
    if (url.pathname === "/_aisdk/deploy" && request.method === "POST") return deploy(request, env, project);
    if (url.pathname.startsWith("/_aisdk/")) {
      if (url.pathname !== "/_aisdk/status" || request.method !== "GET") return new Response("Not found", { status: 404 });
      return Response.json({ commit: project.active_release?.slice(0, 40) ?? null }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
    let path;
    try { path = decodeURIComponent(url.pathname.slice(1)) || "index.html"; } catch { return new Response("Not found", { status: 404 }); }
    if (!validPath(path)) return new Response("Not found", { status: 404 });
    const release = project.active_release;
    if (!release || !/^[a-f0-9]{40}-[a-f0-9-]{36}$/.test(release)) return new Response("Deployment pending", { status: 503 });
    const object = request.method === "HEAD" ? await env.SITES.head(`releases/${release}/${path}`) : await env.SITES.get(`releases/${release}/${path}`);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: { "Content-Type": mime[path.split(".").at(-1)] ?? "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" },
    });
  },
};
