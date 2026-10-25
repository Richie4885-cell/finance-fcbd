// This app's server. Zero npm dependencies (it boots before, and without, any
// install), and it does three jobs:
//
//   1. Your JSON API: the `routes` table below. Data lives in lib/data via
//      lib/store.js; accounts via lib/auth.js.
//   2. The phone app. Expo Go opens exps://<this app>/.vibekit/expo/manifest
//      and downloads the latest build from here. PLATFORM CONTRACT: keep the
//      /.vibekit/expo/* handling as it is.
//   3. The web version of the same app, at this app's address.
//
// Builds are made by the platform on Deploy (never here): each one lands in
// dist/releases/<id>/, and dist/CURRENT names the live one. This server reads
// CURRENT on every request and then reads only inside that release folder,
// which never changes once written, so a deploy switches over in one step.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');


const PORT = process.env.PORT || 3000;
const DIST = path.join(__dirname, 'dist');
const RELEASES = path.join(DIST, 'releases');
const EXPO = '/.vibekit/expo';
const RELEASE_ID_RE = /^r\d{14}-[0-9a-f]{8}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// ── API routes ────────────────────────────────────────────────────────
// Key is "METHOD /path". Handlers get (req, res) and may be async.
const hash = (p) => crypto.scryptSync(p, 'sunshine-trust-v1', 32).toString('hex');
// New accounts never receive an unexplained balance. If the business later
// authorizes an opening credit, set this named configuration and it will be
// recorded as a visible ledger entry during account creation.
const OPENING_ACCOUNT_CREDIT_CENTS = 0;
const accounts = () => store.read('accounts', []); const sessions = () => store.read('sessions', []);
const isString = (v) => typeof v === 'string';
const emailOK = (v) => isString(v) && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const usernameOK = (v) => isString(v) && /^[a-z0-9_]{3,30}$/.test(v);
const amountToCents = (v) => { if (!isString(v) || !/^\d+(?:\.\d{1,2})?$/.test(v)) return null; const [whole, fraction = ''] = v.split('.'); const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2)); return Number.isSafeInteger(cents) && cents > 0 ? cents : null; };
const balanceCents = (a) => Number.isSafeInteger(a.balanceCents) ? a.balanceCents : Math.round(Number(a.balance || 0) * 100);
const publicUser = (a) => ({ id:a.id, name:a.name, email:a.email, username:a.username, role:a.role, balance:balanceCents(a) / 100, createdAt:a.createdAt });
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/, '');
const currentUser = (req) => { const s = sessions().find(x => x.token === bearer(req)); return s && accounts().find(a => a.id === s.userId); };
function requireUser(req, res) { const user = currentUser(req); if (!user) { json(res, { error:'Sign in required' }, 401); return null; } return user; }
function addSession(id) { const token = crypto.randomBytes(32).toString('hex'); store.write('sessions', [...sessions().filter(s => s.userId !== id), { token, userId:id }]); return token; }
async function signup(req,res) { const d=await readBody(req); if (!isString(d.name) || !d.name.trim() || d.name.trim().length > 80) return json(res,{error:'Name must be a string of 1 to 80 characters'},400); if (!emailOK(d.email)) return json(res,{error:'Enter a valid email address'},400); if (!usernameOK(d.username)) return json(res,{error:'Username must be 3–30 lowercase letters, numbers, or underscores'},400); if (!isString(d.password) || d.password.length < 8 || d.password.length > 128) return json(res,{error:'Password must be 8–128 characters'},400); if (d.invite !== undefined && !isString(d.invite)) return json(res,{error:'Invalid invitation'},400); const all=accounts(), email=d.email.toLowerCase(), username=d.username.toLowerCase(), invite=d.invite&&store.read('invites',[]).find(i=>i.code===d.invite&&!i.used); if(all.some(a=>a.email.toLowerCase()===email||a.username.toLowerCase()===username))return json(res,{error:'That email or username is already in use'},409); const role=all.length===0?'admin':invite?'user':null; if(!role)return json(res,{error:'Customer sign-up requires an invitation link'},403); const openingCents = OPENING_ACCOUNT_CREDIT_CENTS;
const a={id:crypto.randomUUID(),name:d.name.trim(),email,username,password:hash(d.password),role,balanceCents:openingCents,createdAt:new Date().toISOString(),transactions:openingCents?[{id:crypto.randomUUID(),name:'Opening account credit',amount:openingCents/100,amountCents:openingCents,status:'Completed',note:'Authorized opening balance',when:new Date().toISOString()}]:[]}; all.push(a);store.write('accounts',all);if(invite){const inv=store.read('invites',[]);inv.find(i=>i.code===invite.code).used=true;store.write('invites',inv)}json(res,{token:addSession(a.id),user:publicUser(a)},201); }
async function login(req,res) { const d=await readBody(req); if (!isString(d.id) || d.id.length < 3 || d.id.length > 254 || !isString(d.password) || d.password.length < 1 || d.password.length > 128) return json(res,{error:'Invalid sign-in details'},400); const id=d.id.toLowerCase(),a=accounts().find(x=>(x.email.toLowerCase()===id||x.username.toLowerCase()===id)&&x.password===hash(d.password)); if(!a)return json(res,{error:'Invalid sign-in details'},401);json(res,{token:addSession(a.id),user:publicUser(a)}); }
async function transfer(req,res) { const from=requireUser(req,res);if(!from)return;const d=await readBody(req); if(!usernameOK(d.recipient))return json(res,{error:'Recipient must be a valid Sunshine Trust username'},400);if(d.note!==undefined&&(!isString(d.note)||d.note.length>140))return json(res,{error:'Memo must be a string of at most 140 characters'},400);const cents=amountToCents(d.amount);if(cents===null)return json(res,{error:'Amount must be a positive value with at most two decimal places'},400);const all=accounts(),to=all.find(a=>a.username.toLowerCase()===d.recipient.toLowerCase());if(!to||to.id===from.id)return json(res,{error:'Choose another Sunshine Trust user by username'},400);const available=balanceCents(from);if(cents>available)return json(res,{error:'Enter an available amount'},400);from.balanceCents=available-cents;to.balanceCents=balanceCents(to)+cents;delete from.balance; delete to.balance;const amount=cents/100,when=new Date().toISOString(),note=d.note||'Sunshine Trust transfer';const debit={id:crypto.randomUUID(),name:to.name,amount:-amount,amountCents:-cents,status:'Completed',note,when};const credit={id:crypto.randomUUID(),name:from.name,amount,amountCents:cents,status:'Completed',note,when};from.transactions.unshift(debit);to.transactions.unshift(credit);store.write('accounts',all);json(res,{balance:from.balanceCents/100,transaction:debit}); }
const routes = {
 'GET /health': (req,res)=>json(res,{status:'ok',uptime:process.uptime(),release:currentRelease()}),
 'POST /api/auth/signup': signup, 'POST /api/auth/login': login,
 'POST /api/auth/logout': (req,res)=>{store.write('sessions',sessions().filter(s=>s.token!==bearer(req)));json(res,{ok:true});},
 'GET /api/auth/me': (req,res)=>{const a=requireUser(req,res);if(a)json(res,{user:publicUser(a),transactions:a.transactions||[]});},
 'POST /api/transfers/internal': transfer,
 'POST /api/invites': async (req,res)=>{const a=requireUser(req,res);if(!a)return;if(a.role!=='admin')return json(res,{error:'Admin access required'},403);const code=crypto.randomBytes(18).toString('base64url'),all=store.read('invites',[]);all.push({code,createdBy:a.id,used:false,createdAt:new Date().toISOString()});store.write('invites',all);json(res,{link:'/invite/'+code},201);},
};

function json(res, data, status = 200, headers = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Parse a JSON request body: `const data = await readBody(req)`. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooLarge = true;
        raw = '';
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function safeDecode(p) {
  try { return decodeURIComponent(p); } catch { return null; }
}

// ── Releases (PLATFORM CONTRACT) ──────────────────────────────────────
/** The live release id, or null before the first deploy. */
function currentRelease() {
  try {
    const id = fs.readFileSync(path.join(DIST, 'CURRENT'), 'utf8').trim();
    return RELEASE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** A file inside a release, or null if the path would leave it. */
function releaseFile(id, rel) {
  const root = path.join(RELEASES, id);
  const file = path.join(root, rel);
  return file.startsWith(root + path.sep) ? file : null;
}

/** The address this request came in on. The platform passes the public host
 *  in X-Forwarded-Host (the Host header here is the container's own). */
function publicOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  const proto = String(req.headers['x-forwarded-proto'] || (local ? 'http' : 'https')).split(',')[0].trim();
  return { host, origin: `${proto}://${host}` };
}

const uuidFrom = (s) => {
  const h = crypto.createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function releaseTime(id) {
  const m = /^r(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(id);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

/**
 * The update manifest Expo Go asks for (expo-updates protocol 1). What each
 * rule is for, all learned on a real phone (docs/mobile-apps-plan.md):
 * - extra.scopeKey is required, or Expo Go refuses to parse the manifest. It
 *   is stable per app address, so the phone keeps this app's storage.
 * - the id is derived from the whole manifest, so ANY change is a new id:
 *   Expo Go caches by id, and a manifest fixed under an old id stays broken.
 * - asset URLs name the release, so a phone that fetched this manifest can
 *   still download them after the next deploy goes live.
 */
function buildManifest(req, platform) {
  const id = currentRelease();
  // Expo Go shows this raw. True whether the first build is still running
  // (gets-8e63, 2026-10-20) or has not started: not "ask its agent".
  if (!id) return { status: 404, error: 'This app is not ready to open yet. When its chat says it is live, open it again.' };
  const meta = JSON.parse(fs.readFileSync(path.join(RELEASES, id, 'metadata.json'), 'utf8'));
  const cfg = JSON.parse(fs.readFileSync(path.join(RELEASES, id, 'expo-config.json'), 'utf8'));
  const fm = meta.fileMetadata && meta.fileMetadata[platform];
  if (!fm) return { status: 404, error: `This app has no ${platform} build.` };
  const runtime = `exposdk:${cfg.sdkVersion}`;
  const wants = req.headers['expo-runtime-version'];
  if (wants && wants !== runtime) {
    // Say which side is behind: when Expo Go is the newer one, updating it
    // cannot help, and the platform moves the app to the new SDK itself.
    const major = (v) => parseInt(String(v).replace('exposdk:', ''), 10);
    if (major(wants) > major(cfg.sdkVersion)) {
      return { status: 404, error: `This app is on Expo SDK ${major(cfg.sdkVersion)}; your Expo Go runs a newer SDK ${major(wants)}. VibeKit is updating it; try again in a little while.` };
    }
    return { status: 404, error: `This app is built for Expo SDK ${cfg.sdkVersion}, and this Expo Go runs ${String(wants).replace('exposdk:', 'SDK ')}. Update Expo Go from the App Store.` };
  }
  const { host, origin } = publicOrigin(req);
  const asset = (rel, ext, isLaunch) => {
    const buf = fs.readFileSync(path.join(RELEASES, id, rel));
    return {
      hash: b64url(crypto.createHash('sha256').update(buf).digest()),
      key: crypto.createHash('md5').update(buf).digest('hex'),
      fileExtension: isLaunch ? '.bundle' : `.${ext}`,
      contentType: isLaunch ? 'application/javascript' : (MIME[`.${ext}`] || 'application/octet-stream'),
      url: `${origin}${EXPO}/r/${id}/${rel}`,
    };
  };
  const body = {
    runtimeVersion: runtime,
    launchAsset: asset(fm.bundle, 'js', true),
    assets: fm.assets.map((a) => asset(a.path, a.ext, false)),
    metadata: {},
    extra: {
      expoClient: { ...cfg, runtimeVersion: runtime, extra: { ...(cfg.extra || {}), apiOrigin: origin } },
      scopeKey: `@anonymous/${cfg.slug}-${uuidFrom(`scope:${host}`)}`,
      eas: {},
    },
  };
  const manifest = { id: uuidFrom(JSON.stringify(body) + platform), createdAt: releaseTime(id), ...body };
  if (!manifest.launchAsset.url || !manifest.extra.scopeKey || !manifest.extra.expoClient.sdkVersion) {
    return { status: 500, error: 'This build is incomplete. Deploy it again.' };
  }
  return { status: 200, manifest };
}

function serveManifest(req, res, url) {
  const common = { 'expo-protocol-version': '1', 'expo-sfv-version': '0', 'Cache-Control': 'private, max-age=0' };
  const platform = req.headers['expo-platform'] || url.searchParams.get('platform') || 'ios';
  const r = buildManifest(req, platform === 'android' ? 'android' : 'ios');
  if (r.status !== 200) return json(res, { error: r.error, message: r.error }, r.status, common);
  const body = JSON.stringify(r.manifest);
  if (/multipart\/mixed/.test(req.headers.accept || '')) {
    const b = `vk${crypto.randomBytes(8).toString('hex')}`;
    const part = (name, content) => `--${b}\r\ncontent-disposition: form-data; name="${name}"\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${content}\r\n`;
    const out = part('manifest', body) + part('extensions', JSON.stringify({ assetRequestHeaders: {} })) + `--${b}--\r\n`;
    res.writeHead(200, { ...common, 'Content-Type': `multipart/mixed; boundary=${b}` });
    return res.end(out);
  }
  res.writeHead(200, { ...common, 'Content-Type': 'application/json' });
  res.end(body);
}

function serveReleaseAsset(res, id, rel) {
  if (!RELEASE_ID_RE.test(id)) return json(res, { error: 'Not found' }, 404);
  const file = releaseFile(id, rel);
  if (!file) return json(res, { error: 'Not found' }, 404);
  fs.readFile(file, (err, data) => {
    if (err) return json(res, { error: 'Not found' }, 404);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(data);
  });
}

const BUILDING_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Building…</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px -apple-system,system-ui,sans-serif;background:#0f0f14;color:#e8e8f0;text-align:center;padding:24px}p{color:#9a9ab0}</style></head>
<body><div><h1>First build in progress</h1><p>This app appears here, and on your phone in Expo Go, once its first version is built.</p></div></body></html>`;

/** The web version: files from the live release, index.html for app routes. */
function serveWeb(req, res, pathname) {
  const id = currentRelease();
  if (!id) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(BUILDING_PAGE);
  }
  const decoded = pathname === '/' ? 'index.html' : safeDecode(pathname);
  if (decoded === null) return json(res, { error: 'Bad request' }, 400);
  const rel = decoded.replace(/^\/+/, '');
  // The build's own bookkeeping is not part of the website.
  if (rel === 'metadata.json' || rel === 'expo-config.json') return json(res, { error: 'Not found' }, 404);
  const file = releaseFile(id, rel);
  if (!file) return json(res, { error: 'Not found' }, 404);
  fs.readFile(file, (err, data) => {
    if (!err) {
      const immutable = rel.startsWith('_expo/static/') || rel.startsWith('assets/');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
      return res.end(data);
    }
    if (path.extname(rel)) return json(res, { error: 'Not found' }, 404);
    fs.readFile(path.join(RELEASES, id, 'index.html'), (e, html) => {
      if (e) return json(res, { error: 'Not found' }, 404);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    });
  });
}

http.createServer(async (req, res) => {
  let pathname = req.url || '/';
  try {
    const url = new URL(req.url, 'http://localhost');
    pathname = url.pathname;
    const handler = routes[`${req.method} ${pathname}`];
    if (handler) return await handler(req, res);
    if (pathname === `${EXPO}/manifest`) return serveManifest(req, res, url);
    if (pathname.startsWith(`${EXPO}/r/`)) {
      const rest = safeDecode(pathname.slice(`${EXPO}/r/`.length));
      if (rest === null) return json(res, { error: 'Bad request' }, 400);
      const slash = rest.indexOf('/');
      if (slash < 1) return json(res, { error: 'Not found' }, 404);
      return serveReleaseAsset(res, rest.slice(0, slash), rest.slice(slash + 1));
    }
    if (pathname.startsWith(`${EXPO}/`) || pathname.startsWith('/api/')) return json(res, { error: 'Not found' }, 404);
    serveWeb(req, res, pathname);
  } catch (err) {
    console.error(`${req.method} ${pathname} failed:`, err.message);
    if (res.headersSent) return;
    if (err.status === 413) json(res, { error: 'Too large: the limit is 10 MB.' }, 413);
    else if (err.status === 400) json(res, { error: err.message }, 400);
    else json(res, { error: 'Server error' }, 500);
  }
}).listen(PORT, () => console.log(`Listening on port ${PORT}`));
