// User service: profile data. Credentials live in Auth, deliberately: a leak of
// the profile table must not expose password hashes.
import { createService, createPool, asyncHandler as ah } from '../../_shared/index.js';

const pool = createPool();
const { app, start } = createService({ name: 'user', pool });

// INTERNAL: called by Auth during registration. The gateway does not route to
// this endpoint (it only allow-lists GET /api/users/me).
app.post('/users', ah(async (req, res) => {
  const { email, name } = req.body ?? {};
  if (!email || !name) return res.status(400).json({ error: 'email and name required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email, name, created_at',
      [email.toLowerCase(), name],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email already registered' }); // unique_violation
    throw err;
  }
}));

// The gateway verified the JWT and set x-user-id; this service trusts it
// because it is only reachable from inside the private network.
app.get('/users/me', ah(async (req, res) => {
  const id = Number(req.headers['x-user-id']);
  if (!id) return res.status(401).json({ error: 'unauthenticated' });
  const { rows } = await pool.query('SELECT id, email, name, created_at FROM users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'user not found' });
  res.json(rows[0]);
}));

start();
