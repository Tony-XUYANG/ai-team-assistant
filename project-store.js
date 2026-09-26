const { randomUUID } = require("node:crypto");

function createProjectStore(pool, accountId) {
  // The zero UUID keeps isolated unit fakes deterministic. Production only exposes this store through forAccount().
  accountId ||= "00000000-0000-4000-8000-000000000000";
  async function withTransaction(callback) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '500ms'");
      await client.query("SET LOCAL transaction_timeout = '6000ms'");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original database error. */ }
      throw error;
    } finally { client.release(); }
  }

  function entry(row) {
    return { ...row, source: row.source || {} };
  }

  async function createProject(input) {
    const id = randomUUID();
    return (await pool.query(`INSERT INTO public.projects
      (id, name, objective, constraints, source, status, account_id)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
      RETURNING id, name, objective, constraints, source, status, created_at, updated_at`,
    [id, input.name, input.objective, JSON.stringify(input.constraints || []), JSON.stringify(input.source || {}), input.status, accountId])).rows[0];
  }

  function page(rows, key, { limit, offset }) {
    const has_more = rows.length > limit;
    return { [key]: rows.slice(0, limit), limit, offset, has_more, next_offset: has_more ? offset + limit : null };
  }

  async function listProjects(options) {
    const rows = (await pool.query(`SELECT p.id, p.name, p.objective, p.constraints, p.source, p.status,
        p.created_at, p.updated_at,
        (SELECT count(*)::int FROM public.project_entries e WHERE e.project_id = p.id
          AND e.kind = 'action' AND e.status IN ('todo', 'doing')
          AND NOT EXISTS (SELECT 1 FROM public.project_entries n WHERE n.supersedes_id = e.id)) AS open_actions,
        (SELECT count(*)::int FROM public.project_entries e WHERE e.project_id = p.id
          AND e.kind = 'blocker' AND e.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM public.project_entries n WHERE n.supersedes_id = e.id)) AS open_blockers,
        (SELECT count(*)::int FROM public.project_entries e WHERE e.project_id = p.id
          AND e.verification = 'unverified'
          AND NOT EXISTS (SELECT 1 FROM public.project_entries n WHERE n.supersedes_id = e.id)) AS unverified_entries,
        COALESCE((SELECT jsonb_agg((to_jsonb(attention) - 'priority')
            ORDER BY attention.priority, attention.created_at DESC, attention.id DESC)
          FROM (
            SELECT e.id, e.project_id, e.kind, left(e.content, 240) AS content,
              char_length(e.content) > 240 AS content_truncated,
              e.verification, e.status, e.owner_ref, e.occurred_at, e.created_at,
              CASE WHEN e.kind = 'blocker' AND e.status = 'open' THEN 0
                WHEN e.kind = 'action' AND e.status IN ('todo', 'doing') THEN 1 ELSE 2 END AS priority
            FROM public.project_entries e
            WHERE e.project_id = p.id
              AND NOT EXISTS (SELECT 1 FROM public.project_entries n WHERE n.supersedes_id = e.id)
              AND ((e.kind = 'blocker' AND e.status = 'open')
                OR (e.kind = 'action' AND e.status IN ('todo', 'doing'))
                OR e.verification = 'unverified')
            ORDER BY priority, e.created_at DESC, e.id DESC
            LIMIT 3
          ) attention), '[]'::jsonb) AS attention
      FROM public.projects p WHERE p.account_id = $3 ORDER BY p.created_at DESC, p.id DESC LIMIT $1 OFFSET $2`,
    [options.limit + 1, options.offset, accountId])).rows;
    return page(rows, "projects", options);
  }

  async function getProject(projectId) {
    const project = (await pool.query(`SELECT id, name, objective, constraints, source, status, created_at, updated_at
      FROM public.projects WHERE id = $1 AND account_id = $2`, [projectId, accountId])).rows[0];
    return project || null;
  }

  async function listProjectEntries(projectId, options) {
    if (!await getProject(projectId)) return null;
    const rows = (await pool.query(`SELECT e.*,
        NOT EXISTS (SELECT 1 FROM public.project_entries n WHERE n.supersedes_id = e.id) AS is_current
      FROM public.project_entries e WHERE e.project_id = $1
        AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = e.project_id AND p.account_id = $4)
      ORDER BY e.created_at DESC, e.id DESC LIMIT $2 OFFSET $3`,
    [projectId, options.limit + 1, options.offset, accountId])).rows;
    return page(rows, "entries", options);
  }

  async function getProjectBrief(projectId) {
    // One statement gives the project, classifications and counts the same snapshot.
    const result = await pool.query(`WITH current_entries AS (
      SELECT e.*, CASE
        WHEN verification = 'unverified' THEN 'unverified'
        WHEN verification = 'disputed' THEN 'disputed'
        WHEN status IN ('resolved', 'done', 'cancelled') THEN 'closed'
        WHEN kind = 'progress' THEN 'confirmed_facts'
        WHEN kind = 'decision' THEN 'decisions'
        WHEN kind = 'blocker' THEN 'blockers' ELSE 'next_actions' END AS section
      FROM public.project_entries e WHERE project_id = $1
        AND NOT EXISTS (SELECT 1 FROM public.project_entries n WHERE n.supersedes_id = e.id)
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY section ORDER BY created_at DESC, id DESC) AS position,
        count(*) OVER (PARTITION BY section)::int AS total FROM current_entries
    ) SELECT to_jsonb(p) - 'account_id' AS project, NOW() AS generated_at,
      COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC, r.id DESC)
        FROM ranked r WHERE position <= 50), '[]'::jsonb) AS records
      FROM public.projects p WHERE p.id = $1 AND p.account_id = $2`, [projectId, accountId]);
    if (!result.rowCount) return null;
    const { project, generated_at, records } = result.rows[0];
    const sections = Object.fromEntries(["confirmed_facts", "decisions", "blockers", "next_actions", "unverified", "disputed", "closed"]
      .map(key => [key, { entries: [], total: 0, truncated: false }]));
    for (const { section, total, position, ...record } of records) {
      sections[section].entries.push(record);
      sections[section].total = total;
      sections[section].truncated = total > 50;
    }
    return { project, generated_at, mode: "recorded_context", verification_basis: "caller_asserted", sections };
  }

  async function createProjectEntry(projectId, input) {
    return withTransaction(async client => {
      const project = await client.query("SELECT id FROM public.projects WHERE id = $1 AND account_id = $2 FOR UPDATE", [projectId, accountId]);
      if (!project.rowCount) return null;
      if (input.supersedes_id) {
        const prior = (await client.query(`SELECT kind FROM public.project_entries
          WHERE project_id = $1 AND id = $2`, [projectId, input.supersedes_id])).rows[0];
        if (!prior) return null;
        if (prior.kind !== input.kind) return { error: "kind_mismatch" };
        if ((await client.query("SELECT id FROM public.project_entries WHERE supersedes_id = $1", [input.supersedes_id])).rowCount) {
          return { error: "conflict" };
        }
      }
      const result = await client.query(`INSERT INTO public.project_entries
        (id, project_id, kind, content, verification, status, owner_ref, source, occurred_at, supersedes_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
        RETURNING id, project_id, kind, content, verification, status, owner_ref, source, occurred_at, created_at, supersedes_id`,
      [randomUUID(), projectId, input.kind, input.content, input.verification, input.status,
        input.owner_ref || null, JSON.stringify(input.source || {}), input.occurred_at || new Date().toISOString(), input.supersedes_id || null]);
      await client.query("UPDATE public.projects SET updated_at = NOW() WHERE id = $1", [projectId]);
      return entry(result.rows[0]);
    });
  }

  return { createProject, listProjects, getProject, getProjectBrief, createProjectEntry, listProjectEntries };
}

module.exports = { createProjectStore };
