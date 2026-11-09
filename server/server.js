// 설문 응답 수신 서버: POST /responses → MariaDB 저장 → ntfy 푸시 + events.log 기록
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const mysql = require('mysql2/promise');

const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);
const PORT = Number(env.PORT || 8787);
const ORIGIN = env.ALLOWED_ORIGIN;
const LOG = path.join(__dirname, 'events.log');

const pool = mysql.createPool({
  host: 'localhost', user: env.DB_USER, password: env.DB_PASS, database: env.DB_NAME,
  waitForConnections: true, connectionLimit: 4, charset: 'utf8mb4',
});

// ntfy 푸시 (실패해도 저장에는 영향 없음)
function notify(title, message) {
  if (!env.NTFY_TOPIC) return;
  const body = JSON.stringify({ topic: env.NTFY_TOPIC, title, message, tags: ['memo'] });
  const req = https.request('https://ntfy.sh/', {
    method: 'POST', timeout: 10000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, r => r.resume());
  req.on('error', e => console.error(new Date().toISOString(), 'ntfy', e.message));
  req.on('timeout', () => req.destroy());
  req.end(body);
}

// IP당 10분에 5건
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const picks = v => (Array.isArray(v) ? v.slice(0, 20).map(p => ({ name: str(p && p.name, 100), note: str(p && p.note, 500) })).filter(p => p.name) : []);

function clean(b) {
  return {
    insta: str(b.insta, 100),
    years: str(b.years, 30),
    kinds: picks(b.kinds),
    recent: str(b.recent, 300),
    process: picks(b.process),
    tools: str(b.tools, 3000),
    hard: picks(b.hard),
    early: str(b.early, 3000),
    interview: str(b.interview, 30),
    consent: b.consent === true,
  };
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/responses') return send(res, 404, { error: 'not_found' });

  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
  if (limited(ip)) return send(res, 429, { error: 'too_many' });

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) return send(res, 413, { error: 'too_large' });
  }

  let body;
  try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'bad_json' }); }
  if (body.website) return send(res, 200, { ok: true }); // 봇용 숨은 칸

  const a = clean(body);
  if (!a.insta || !a.recent || !a.process.length || !a.hard.length || !a.consent) {
    return send(res, 400, { error: 'missing_required' });
  }

  try {
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
    const [r] = await pool.execute(
      'INSERT INTO responses (insta, years, interview, answers, ip_hash) VALUES (?, ?, ?, ?, ?)',
      [a.insta, a.years || null, a.interview || null, JSON.stringify(a), ipHash]
    );
    const line = [
      'NEW_RESPONSE', `#${r.insertId}`, a.insta,
      'hard=' + a.hard.map(p => p.name).join('/'),
      'interview=' + (a.interview || '-'),
    ].join(' | ').replace(/[\r\n]+/g, ' ');
    fs.appendFileSync(LOG, line + '\n');
    notify(`새 설문 응답 #${r.insertId} · ${a.insta}`,
      `까다로운 과정: ${a.hard.map(p => p.name).join(', ')}\n추가 인터뷰: ${a.interview || '응답 안 함'}`);
    send(res, 201, { ok: true });
  } catch (e) {
    console.error(new Date().toISOString(), e.message);
    notify('설문 저장 실패', e.message.slice(0, 200));
    send(res, 500, { error: 'save_failed' });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`survey server on 127.0.0.1:${PORT}`));
