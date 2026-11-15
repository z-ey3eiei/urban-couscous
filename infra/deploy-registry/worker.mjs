const headers = { "Cache-Control": "no-store" };
const json = (value, status = 200) => Response.json(value, { status, headers });

export default {
  async fetch(request, env) {
    const match = /^\/projects\/([a-z0-9-]{1,63})(\/upload)?$/.exec(new URL(request.url).pathname);
    if (!match) return json({ error: "not_found" }, 404);
    const id = match[1];
    if (match[2]) {
      const { lease } = await request.json().catch(() => ({})) ?? {};
      if (typeof lease !== "string" || !/^[a-f0-9-]{36}$/.test(lease)) return json({ error: "invalid_lease" }, 422);
      if (request.method === "DELETE") {
        await env.REGISTRY.prepare("DELETE FROM upload_leases WHERE project_id=? AND lease_id=?").bind(id, lease).run();
        return new Response(null, { status: 204 });
      }
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const acquire = env.REGISTRY.prepare(`
        INSERT INTO upload_leases (project_id,lease_id,started_at)
        SELECT id,?,unixepoch() FROM projects WHERE id=? AND enabled=1
        AND coalesce((SELECT uploads FROM upload_usage WHERE project_id=? AND utc_day=date('now')),0)<20
        ON CONFLICT(project_id) DO UPDATE SET lease_id=excluded.lease_id,started_at=excluded.started_at
        WHERE upload_leases.started_at < unixepoch()-600
      `).bind(lease,id,id);
      const count = env.REGISTRY.prepare(`
        INSERT INTO upload_usage (project_id,utc_day,uploads)
        SELECT project_id,date('now'),1 FROM upload_leases WHERE project_id=? AND lease_id=?
        ON CONFLICT(project_id,utc_day) DO UPDATE SET uploads=uploads+1
      `).bind(id,lease);
      const [result] = await env.REGISTRY.batch([acquire,count]);
      return result.meta.changes === 1 ? json({ accepted: true }) : json({ error: "project_upload_limit" }, 429);
    }
    const project = env.REGISTRY.prepare(
      "SELECT id, repository_id, repository, branch, workflow, origin, enabled, active_release, run_number, run_attempt FROM projects WHERE id = ?"
    ).bind(id);
    if (request.method === "GET") {
      const result = await project.first();
      return result ? json(result) : json({ error: "not_found" }, 404);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let release;
    try { release = await request.json(); } catch { return json({ error: "invalid_release" }, 422); }
    if (!release || !/^[0-9a-f]{40}$/.test(release.commit || "") ||
        !/^[0-9a-f]{40}-[0-9a-f-]{36}$/.test(release.id || "") ||
        !release.id.startsWith(release.commit + "-") ||
        !Number.isSafeInteger(release.run) || release.run <= 0 ||
        !Number.isSafeInteger(release.attempt) || release.attempt <= 0) {
      return json({ error: "invalid_release" }, 422);
    }
    const insert = env.REGISTRY.prepare(`
      INSERT INTO releases (project_id, release, commit_sha, run_number, run_attempt)
      SELECT id, ?, ?, ?, ? FROM projects
      WHERE id = ? AND enabled = 1
        AND (run_number < ? OR (run_number = ? AND run_attempt < ?))
      ON CONFLICT(project_id, run_number, run_attempt) DO NOTHING
    `).bind(release.id, release.commit, release.run, release.attempt, id, release.run, release.run, release.attempt);
    const promote = env.REGISTRY.prepare(`
      UPDATE projects SET active_release = ?, run_number = ?, run_attempt = ?
      WHERE id = ? AND enabled = 1
        AND (run_number < ? OR (run_number = ? AND run_attempt < ?))
        AND EXISTS (SELECT 1 FROM releases WHERE project_id = ? AND release = ?)
    `).bind(release.id, release.run, release.attempt, id, release.run, release.run, release.attempt, id, release.id);
    const results = await env.REGISTRY.batch([insert, promote, project]);
    const current = results[2].results[0];
    if (!current || !current.enabled) return json({ error: "project_disabled" }, 403);
    if (current.active_release !== release.id) return json({ error: "release_already_processed" }, 409);
    return json({ commit: release.commit, url: current.origin + "/" });
  },
};
