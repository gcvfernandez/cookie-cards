import express from 'express';
import pg from 'pg';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';
const TZ = process.env.APP_TIMEZONE || 'Asia/Manila';
const YEAR = 400 * 24 * 3600 * 1000; // browsers cap cookie life at about 400 days

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params) => pool.query(text, params);

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      pin TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('photo','video')),
      title TEXT NOT NULL DEFAULT '',
      taken_on DATE,
      original_path TEXT NOT NULL,
      poster_path TEXT,
      cartoon_path TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live')),
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pulls (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, card_id),
      UNIQUE (user_id, day)
    );
    -- The one-a-day rule is enforced in code so a signed-in admin can open without limit.
    ALTER TABLE pulls DROP CONSTRAINT IF EXISTS pulls_user_id_day_key;
  `);
}

// ---------- helpers ----------

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req, res, name, value, maxAge = YEAR) {
  res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge, path: '/' });
}

const adminToken = () => crypto.createHash('sha256').update('ctc-admin:' + ADMIN_PASSWORD).digest('hex');
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const got = Buffer.from(cookies(req).ctc_admin || '');
  const want = Buffer.from(adminToken());
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function currentUser(req) {
  const token = cookies(req).ctc_session;
  if (!token) return null;
  const r = await q('SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1', [token]);
  return r.rows[0] || null;
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const needUser = wrap(async (req, res, next) => {
  req.user = await currentUser(req);
  if (!req.user) return res.status(401).json({ error: 'Please enter your PIN.' });
  next();
});
const needAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Admin sign-in needed.' }));

// Small in-memory limiter so the 3-digit PIN can't be guessed by brute force.
const attempts = new Map();
function limited(req, max = 8, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const list = (attempts.get(req.ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  attempts.set(req.ip, list);
  return list.length > max;
}

const validPin = (p) => typeof p === 'string' && /^[1-9]{3}$/.test(p);

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  setCookie(req, res, 'ctc_session', token);
}

// Live cards, numbered in the order they were added.
const NUMBERED = `(SELECT c.*, row_number() OVER (ORDER BY c.id) AS no FROM cards c WHERE c.status = 'live')`;
const media = (file) => (file ? '/media/' + file : null);
const cardJson = (r) => ({
  id: r.id,
  no: Number(r.no),
  kind: r.kind,
  title: r.title,
  taken_on: r.taken_on,
  cartoon: media(r.cartoon_path),
  original: media(r.original_path),
  poster: media(r.poster_path),
});

// ---------- player API ----------

app.post('/api/pin', wrap(async (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  const { pin } = req.body || {};
  if (!validPin(pin)) return res.status(400).json({ error: 'Enter 3 digits.' });
  const r = await q('SELECT id, name FROM users WHERE pin = $1', [pin]);
  if (!r.rows[0]) return res.json({ isNew: true });
  await startSession(req, res, r.rows[0].id);
  res.json({ isNew: false, name: r.rows[0].name });
}));

app.post('/api/register', wrap(async (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  const { pin } = req.body || {};
  const name = String((req.body || {}).name || '').trim().slice(0, 24);
  if (!validPin(pin)) return res.status(400).json({ error: 'Enter 3 digits.' });
  if (!name) return res.status(400).json({ error: 'Please type your name.' });
  const r = await q('INSERT INTO users (name, pin) VALUES ($1, $2) ON CONFLICT (pin) DO NOTHING RETURNING id', [name, pin]);
  if (!r.rows[0]) return res.status(409).json({ error: 'That PIN was just taken. Pick another.' });
  await startSession(req, res, r.rows[0].id);
  res.json({ ok: true });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const token = cookies(req).ctc_session;
  if (token) await q('DELETE FROM sessions WHERE token = $1', [token]);
  res.clearCookie('ctc_session', { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/state', wrap(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.json({ user: null });
  const [counts, today, clock] = await Promise.all([
    q(`SELECT (SELECT count(*) FROM cards WHERE status = 'live')::int AS total,
              (SELECT count(*) FROM pulls p JOIN cards c ON c.id = p.card_id AND c.status = 'live' WHERE p.user_id = $1)::int AS owned`, [user.id]),
    q(`SELECT n.* FROM pulls p JOIN ${NUMBERED} n ON n.id = p.card_id
       WHERE p.user_id = $1 AND p.day = (now() AT TIME ZONE $2)::date`, [user.id, TZ]),
    q(`SELECT (extract(epoch FROM ((date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1) - now()) * 1000)::bigint AS ms`, [TZ]),
  ]);
  const { total, owned } = counts.rows[0];
  const unlimited = isAdmin(req);
  res.json({
    user: { name: user.name },
    total,
    owned,
    unlimited,
    today: today.rows[0] && !unlimited ? cardJson(today.rows[0]) : null,
    msToNext: Number(clock.rows[0].ms),
  });
}));

app.post('/api/open', needUser, wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [req.user.id]);
    const day = (await client.query('SELECT (now() AT TIME ZONE $1)::date AS d', [TZ])).rows[0].d;
    let cardId;
    let fresh = false;
    // An admin signed in on this browser can open as many packs as they like.
    const already = isAdmin(req)
      ? { rows: [] }
      : await client.query('SELECT card_id FROM pulls WHERE user_id = $1 AND day = $2 ORDER BY created_at LIMIT 1', [req.user.id, day]);
    if (already.rows[0]) {
      cardId = already.rows[0].card_id;
    } else {
      const left = await client.query(
        `SELECT id FROM cards WHERE status = 'live' AND id NOT IN (SELECT card_id FROM pulls WHERE user_id = $1)`, [req.user.id]);
      if (!left.rows.length) {
        await client.query('COMMIT');
        return res.json({ done: true });
      }
      // True randomness per person, independent of the date.
      cardId = left.rows[crypto.randomInt(left.rows.length)].id;
      await client.query('INSERT INTO pulls (user_id, card_id, day) VALUES ($1, $2, $3)', [req.user.id, cardId, day]);
      fresh = true;
    }
    await client.query('COMMIT');
    const card = await q(`SELECT * FROM ${NUMBERED} n WHERE n.id = $1`, [cardId]);
    res.json({ card: card.rows[0] ? cardJson(card.rows[0]) : null, fresh });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

app.get('/api/collection', needUser, wrap(async (req, res) => {
  const [total, mine] = await Promise.all([
    q(`SELECT count(*)::int AS n FROM cards WHERE status = 'live'`),
    q(`SELECT n.* FROM pulls p JOIN ${NUMBERED} n ON n.id = p.card_id WHERE p.user_id = $1 ORDER BY n.no`, [req.user.id]),
  ]);
  res.json({ total: total.rows[0].n, cards: mine.rows.map(cardJson) });
}));

// ---------- media ----------

app.use('/media', wrap(async (req, res, next) => {
  if (isAdmin(req) || (await currentUser(req))) return next();
  res.status(401).end();
}), express.static(MEDIA_DIR, { maxAge: '30d', immutable: true, index: false }));

// ---------- Gemini (cartoon + title) ----------

async function gemini(body) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Gemini error ${r.status}`);
  return j;
}

// The response nests its outputs; find the first part of the wanted type wherever it sits.
function findPart(node, type, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (node.type === type && typeof (type === 'image' ? node.data : node.text) === 'string') return node;
  for (const v of Object.values(node)) {
    const hit = findPart(v, type, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const CARTOON_PROMPT =
  'Redraw this photo as a cheerful hand-drawn cartoon illustration with bold dark outlines and flat, bright colours, ' +
  'like the art on a children\'s trading card. The dog is Cookie, a female Yorkshire terrier: keep her recognisable, with the ' +
  'same pose, coat colours, markings and expression, and keep the same composition and background elements, simplified. ' +
  'Portrait orientation. No text, no border, no frame.';
const TITLE_PROMPT =
  'This is a photo of Cookie, a much-loved female Yorkshire terrier. Write a short, warm title of 2 to 4 words for it, ' +
  'as it would appear on a keepsake memory card. Describe what is happening in the picture. ' +
  'Reply with the title only: no quotes, no full stop.';

async function makeCartoon(sourceFile) {
  const data = fs.readFileSync(path.join(MEDIA_DIR, sourceFile)).toString('base64');
  const input = [{ type: 'text', text: CARTOON_PROMPT }, { type: 'image', mime_type: 'image/jpeg', data }];
  let j;
  try {
    j = await gemini({ model: IMAGE_MODEL, input, response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '3:4' } });
  } catch {
    j = await gemini({ model: IMAGE_MODEL, input });
  }
  const part = (j.output_image && j.output_image.data ? j.output_image : null) || findPart(j.outputs || j, 'image');
  if (!part) throw new Error('The image service returned no picture.');
  const ext = /png/.test(part.mime_type || '') ? '.png' : '.jpg';
  const name = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(MEDIA_DIR, name), Buffer.from(part.data, 'base64'));
  return name;
}

async function makeTitle(sourceFile) {
  const data = fs.readFileSync(path.join(MEDIA_DIR, sourceFile)).toString('base64');
  const j = await gemini({ model: TEXT_MODEL, input: [{ type: 'text', text: TITLE_PROMPT }, { type: 'image', mime_type: 'image/jpeg', data }] });
  const text = typeof j.output_text === 'string' ? j.output_text : (findPart(j.outputs || j, 'text') || {}).text;
  if (!text) throw new Error('The title service returned nothing.');
  return text.trim().replace(/^["'“”]+|["'“”.]+$/g, '').slice(0, 60);
}

async function generateFor(card, { cartoon = true, title = true } = {}) {
  const source = card.poster_path || card.original_path;
  const [c, t] = await Promise.allSettled([
    cartoon ? makeCartoon(source) : Promise.resolve(null),
    title ? makeTitle(source) : Promise.resolve(null),
  ]);
  const errors = [c, t].filter((x) => x.status === 'rejected').map((x) => x.reason.message);
  if (c.status === 'fulfilled' && c.value) {
    if (card.cartoon_path) fs.rm(path.join(MEDIA_DIR, card.cartoon_path), () => {});
    await q('UPDATE cards SET cartoon_path = $1 WHERE id = $2', [c.value, card.id]);
  }
  if (t.status === 'fulfilled' && t.value) await q('UPDATE cards SET title = $1 WHERE id = $2', [t.value, card.id]);
  await q('UPDATE cards SET error = $1 WHERE id = $2', [errors.join(' ') || null, card.id]);
}

// ---------- admin API ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
      cb(null, crypto.randomUUID() + (ext || '.bin'));
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

app.post('/api/admin/login', (req, res) => {
  if (limited(req, 10)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'ADMIN_PASSWORD is not set on the server.' });
  if ((req.body || {}).password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password.' });
  setCookie(req, res, 'ctc_admin', adminToken(), 30 * 24 * 3600 * 1000);
  res.json({ ok: true });
});

app.get('/api/admin/cards', needAdmin, wrap(async (req, res) => {
  const [cards, people] = await Promise.all([
    q('SELECT * FROM cards ORDER BY id DESC'),
    q(`SELECT u.name, u.created_at, count(p.card_id)::int AS owned FROM users u LEFT JOIN pulls p ON p.user_id = u.id GROUP BY u.id ORDER BY u.id`),
  ]);
  res.json({
    aiReady: !!GEMINI_API_KEY,
    cards: cards.rows.map((r) => ({ ...cardJson({ ...r, no: 0 }), status: r.status, error: r.error })),
    people: people.rows,
  });
}));

app.post('/api/admin/upload', needAdmin, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'poster', maxCount: 1 }]), wrap(async (req, res) => {
  const file = req.files && req.files.file && req.files.file[0];
  const poster = req.files && req.files.poster && req.files.poster[0];
  if (!file) return res.status(400).json({ error: 'No file received.' });
  const kind = req.body.kind === 'video' ? 'video' : 'photo';
  if (kind === 'video' && !poster) return res.status(400).json({ error: 'Video is missing its still frame.' });
  const takenOn = /^\d{4}-\d{2}-\d{2}$/.test(req.body.taken_on || '') ? req.body.taken_on : null;
  const r = await q(
    'INSERT INTO cards (kind, original_path, poster_path, taken_on) VALUES ($1, $2, $3, $4) RETURNING *',
    [kind, file.filename, poster ? poster.filename : null, takenOn]);
  await generateFor(r.rows[0]);
  res.json({ ok: true, id: r.rows[0].id });
}));

app.post('/api/admin/reset-me', needAdmin, wrap(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(400).json({ error: 'Enter your PIN in the app on this browser first.' });
  await q('DELETE FROM pulls WHERE user_id = $1', [user.id]);
  res.json({ ok: true, name: user.name });
}));

app.post('/api/admin/cards/:id', needAdmin, wrap(async (req, res) => {
  const { title, taken_on, status } = req.body || {};
  const cur = (await q('SELECT * FROM cards WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Card not found.' });
  if (status === 'live' && !cur.cartoon_path) return res.status(400).json({ error: 'This card has no cartoon yet. Regenerate it first.' });
  await q('UPDATE cards SET title = $1, taken_on = $2, status = $3 WHERE id = $4', [
    typeof title === 'string' ? title.trim().slice(0, 60) : cur.title,
    taken_on === '' ? null : (/^\d{4}-\d{2}-\d{2}$/.test(taken_on || '') ? taken_on : cur.taken_on),
    status === 'live' || status === 'draft' ? status : cur.status,
    cur.id,
  ]);
  res.json({ ok: true });
}));

app.post('/api/admin/cards/:id/regenerate', needAdmin, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM cards WHERE id = $1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Card not found.' });
  await generateFor(cur, { cartoon: true, title: !!(req.body || {}).title });
  res.json({ ok: true });
}));

app.delete('/api/admin/cards/:id', needAdmin, wrap(async (req, res) => {
  const r = await q('DELETE FROM cards WHERE id = $1 RETURNING original_path, poster_path, cartoon_path', [req.params.id]);
  for (const f of Object.values(r.rows[0] || {})) if (f) fs.rm(path.join(MEDIA_DIR, f), () => {});
  res.json({ ok: true });
}));

// ---------- pages ----------

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (300 MB max).' : 'Something went wrong. Please try again.' });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`Cookie's Cards listening on ${PORT}`)))
  .catch((e) => {
    console.error('Could not start:', e);
    process.exit(1);
  });
