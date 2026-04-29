import OSS from 'ali-oss';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Sync-Password'
};

function resp(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders
    },
    body: JSON.stringify(data)
  };
}

function decodeEvent(event) {
  let raw = event;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf-8');
  if (raw && typeof raw === 'object' && raw.type === 'Buffer' && Array.isArray(raw.data)) {
    raw = Buffer.from(raw.data).toString('utf-8');
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw || {};
}

function getHeader(headers = {}, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? String(v[0] || '') : String(v || '');
  }
  return '';
}

function decodeBody(req) {
  if (!req?.body) return '';
  if (req.isBase64Encoded) {
    try {
      return Buffer.from(req.body, 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }
  return String(req.body);
}

function createClient() {
  const region = process.env.OSS_REGION || 'cn-hangzhou';
  const endpoint = process.env.OSS_ENDPOINT || '';
  const bucket = process.env.OSS_BUCKET;
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || process.env.ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || process.env.ACCESS_KEY_SECRET;
  const securityToken = process.env.ALIBABA_CLOUD_SECURITY_TOKEN || process.env.SECURITY_TOKEN;

  if (!bucket) throw new Error('OSS_BUCKET missing');

  const opts = { region, bucket };
  if (endpoint) opts.endpoint = endpoint;
  opts.secure = true;
  if (accessKeyId && accessKeySecret) {
    opts.accessKeyId = accessKeyId;
    opts.accessKeySecret = accessKeySecret;
    if (securityToken) opts.stsToken = securityToken;
  }

  return new OSS(opts);
}

async function ensureBucket(client) {
  try {
    await client.getBucketInfo(client.options.bucket);
  } catch (e) {
    if ((e.code || '').includes('NoSuchBucket') || e.status === 404) {
      await client.putBucket(client.options.bucket);
    } else {
      throw e;
    }
  }
}

async function readSchedule(client) {
  const key = process.env.OSS_OBJECT_KEY || 'schedule.json';
  try {
    const result = await client.get(key);
    const content = result.content.toString('utf-8');
    const parsed = JSON.parse(content);
    return {
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      updatedAt: parsed.updatedAt || new Date().toISOString()
    };
  } catch (e) {
    if (e.status === 404 || (e.code || '').includes('NoSuchKey')) {
      return { reminders: [], updatedAt: new Date().toISOString() };
    }
    throw e;
  }
}

async function writeSchedule(client, reminders) {
  const key = process.env.OSS_OBJECT_KEY || 'schedule.json';
  const payload = {
    reminders: Array.isArray(reminders) ? reminders : [],
    updatedAt: new Date().toISOString()
  };
  await client.put(key, Buffer.from(JSON.stringify(payload, null, 2), 'utf-8'));
  return payload;
}

export const handler = async (event) => {
  try {
    const req = decodeEvent(event);
    const method = (req?.requestContext?.http?.method || req?.httpMethod || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: corsHeaders, body: '' };
    }

    const password = getHeader(req.headers, 'X-Sync-Password');
    if (!password || password !== String(process.env.SYNC_PASSWORD || '')) {
      return resp(401, { ok: false, error: 'Unauthorized' });
    }

    const client = createClient();
    await ensureBucket(client);

    if (method === 'GET') {
      const schedule = await readSchedule(client);
      return resp(200, { ok: true, ...schedule });
    }

    if (method === 'POST') {
      const rawBody = decodeBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const saved = await writeSchedule(client, body.reminders || []);
      return resp(200, { ok: true, ...saved });
    }

    return resp(405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    return resp(500, { ok: false, error: error.message || 'Unknown error' });
  }
};
