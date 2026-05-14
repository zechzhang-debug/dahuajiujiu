const ALLOWED_HOSTS = new Set([
  "s-file-1.ykt.cbern.com.cn",
  "bdcs-file-2.ykt.cbern.com.cn",
  "r1-ndr.ykt.cbern.com.cn",
  "r2-ndr.ykt.cbern.com.cn",
  "r3-ndr.ykt.cbern.com.cn",
  "keben.app",
  "dlcn.keben.app",
  "dl6.keben.app"
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range"
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestGet({ request }) {
  const requestUrl = new URL(request.url);
  const rawTarget = requestUrl.searchParams.get("url");

  if (!rawTarget) {
    return json({ error: "缺少 url 参数" }, 400);
  }

  let target;
  try {
    target = new URL(rawTarget);
  } catch (_) {
    return json({ error: "url 参数不是有效网址" }, 400);
  }

  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return json({ error: "这个来源不在允许列表中" }, 403);
  }

  const upstream = await fetch(target.toString(), {
    headers: {
      "Accept": request.headers.get("Accept") || "*/*",
      "User-Agent": "Mozilla/5.0 TextbookDownloader/1.0",
      "Referer": "https://basic.smartedu.cn/"
    },
    cf: { cacheTtl: 3600, cacheEverything: true }
  });

  const headers = new Headers(CORS_HEADERS);
  const contentType = upstream.headers.get("Content-Type");
  const contentLength = upstream.headers.get("Content-Length");
  const contentDisposition = upstream.headers.get("Content-Disposition");

  if (contentType) headers.set("Content-Type", contentType);
  if (contentLength) headers.set("Content-Length", contentLength);
  if (contentDisposition) headers.set("Content-Disposition", contentDisposition);
  headers.set("Cache-Control", upstream.ok ? "public, max-age=3600" : "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
