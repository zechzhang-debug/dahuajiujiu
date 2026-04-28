const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Sync-Password"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

function unauthorized() {
  return json({ ok: false, error: "Unauthorized" }, 401);
}

function getGithubApiUrl(repo, path, branch) {
  return `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
}

function decodeBase64Utf8(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function fetchSchedule(env) {
  const url = getGithubApiUrl(env.GITHUB_REPO, env.GITHUB_PATH, env.GITHUB_BRANCH);
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  });

  if (resp.status === 404) {
    return { reminders: [], updatedAt: new Date().toISOString(), sha: null };
  }
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`GitHub read failed (${resp.status}): ${msg}`);
  }

  const data = await resp.json();
  const raw = decodeBase64Utf8(data.content.replace(/\n/g, ""));
  const parsed = JSON.parse(raw);
  return {
    reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
    updatedAt: parsed.updatedAt || new Date().toISOString(),
    sha: data.sha
  };
}

async function saveSchedule(env, schedule, existingSha) {
  const api = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${env.GITHUB_PATH}`;
  const payload = {
    message: `chore: sync schedule ${new Date().toISOString()}`,
    content: encodeBase64Utf8(JSON.stringify(schedule, null, 2)),
    branch: env.GITHUB_BRANCH
  };
  if (existingSha) payload.sha = existingSha;

  const resp = await fetch(api, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`GitHub write failed (${resp.status}): ${msg}`);
  }
  const data = await resp.json();
  return data?.content?.sha || null;
}

function checkAuth(request, env) {
  const pass = request.headers.get("X-Sync-Password") || "";
  return pass && env.SYNC_PASSWORD && pass === env.SYNC_PASSWORD;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    if (url.pathname !== "/schedule") {
      return json({ ok: false, error: "Not found" }, 404);
    }

    if (!checkAuth(request, env)) return unauthorized();

    try {
      if (request.method === "GET") {
        const schedule = await fetchSchedule(env);
        return json({ ok: true, ...schedule });
      }

      if (request.method === "POST") {
        const body = await request.json();
        const existing = await fetchSchedule(env);
        const schedule = {
          reminders: Array.isArray(body.reminders) ? body.reminders : [],
          updatedAt: new Date().toISOString()
        };
        const sha = await saveSchedule(env, schedule, existing.sha);
        return json({ ok: true, sha, updatedAt: schedule.updatedAt });
      }

      return json({ ok: false, error: "Method not allowed" }, 405);
    } catch (error) {
      return json({ ok: false, error: error.message || "Unknown error" }, 500);
    }
  }
};
