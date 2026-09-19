// Auth service: registration + login, issues JWTs. Does NOT verify them on each
// request - the gateway does that, so auth is not on the hot path of every call.
import bcrypt from 'bcryptjs'; // pure JS: no native build step in the alpine image
import jwt from 'jsonwebtoken';
import { createService, createPool, callService, asyncHandler as ah } from '../../_shared/index.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is required'); // fail fast rather than sign with a default
const USER_URL = process.env.USER_SERVICE_URL || 'http://user:3000';

const pool = createPool();
const { app, start } = createService({ name: 'auth', pool });

app.post('/auth/register', ah(async (req, res) => {
  const { email, password, name } = req.body ?? {};
  if (!email || !name || !password || password.length < 8) {
    return res.status(400).json({ error: 'email, name and password (min 8 chars) required' });
  }
  // Profile first: its unique-email check gives us the 409 for free.
  // Trade-off (worth stating in the viva): if the credential insert below fails
  // we leave an orphan profile. A saga/outbox would fix it; out of scope here.
  let user;
  try {
    user = await callService(USER_URL, '/users', { method: 'POST', body: { email, name }, requestId: req.id });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: 'email already registered' });
    throw err;
  }
  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO credentials (email, password_hash, user_id) VALUES ($1, $2, $3)', [
    email.toLowerCase(), hash, user.id,
  ]);
  res.status(201).json({ id: user.id, email: user.email, name: user.name });
}));

app.post('/auth/login', ah(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { rows } = await pool.query('SELECT password_hash, user_id FROM credentials WHERE email = $1', [
    email.toLowerCase(),
  ]);
  // Same error for "no such user" and "wrong password": don't reveal which emails exist.
  const ok = rows[0] && (await bcrypt.compare(password, rows[0].password_hash));
  if (!ok) {
    res.locals.error = 'invalid_credentials'; // lands in the access log for diagnosis
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = jwt.sign({ sub: String(rows[0].user_id) }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ token, token_type: 'Bearer', expires_in: 3600 });
}));

start();
