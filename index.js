/**
 * index.js - Mumma Tiffin (Single-file full stack)
 *
 * Features:
 * - Express backend with SQLite (mumma.db)
 * - User register/login (JWT)
 * - Multi-admin login/create/list (each admin can be assigned a city)
 * - Menu CRUD (admin); public menu reads filtered by city and active flag
 * - Orders (users create; admins view/update status)
 * - Notifications (admins post; users see popup banner)
 * - Addresses saving
 * - Embedded single-page frontend (responsive, dark/light, EN/HI, admin dashboard)
 *
 * Run:
 * 1) npm init -y
 * 2) npm install express sqlite3 bcryptjs cors dotenv jsonwebtoken
 * 3) node index.js
 *
 * Deploy:
 * - Push to GitHub and deploy on Render/Railway with start command `node index.js`
 * - Set env var JWT_SECRET to a secure value on the host
 *
 * IMPORTANT: This is a demo starter. For production, migrate to a server-side DB (Postgres), secure JWT_SECRET,
 * enable HTTPS, add input validation and rate-limiting, and add proper logging & backups.
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, 'mumma.db');
const JWT_SECRET = process.env.JWT_SECRET || 'mummatiffin_dev_secret_change_me';
const PORT = process.env.PORT || 3000;

/* -----------------------
   SQLite helpers & init
   ----------------------- */
const db = new sqlite3.Database(DB_FILE);

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function getSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}
function allSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  // create tables
  await runSql(`PRAGMA foreign_keys = ON;`);
  await runSql(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password_hash TEXT,
    name TEXT,
    created_at TEXT
  );`);
  await runSql(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password_hash TEXT,
    name TEXT,
    city TEXT,
    created_at TEXT
  );`);
  await runSql(`CREATE TABLE IF NOT EXISTS menu (
    id TEXT PRIMARY KEY,
    meal TEXT,
    name_en TEXT,
    name_hi TEXT,
    price INTEGER,
    description_en TEXT,
    description_hi TEXT,
    city TEXT,
    available_from TEXT,
    available_to TEXT,
    active INTEGER DEFAULT 1
  );`);
  await runSql(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT,
    created_at TEXT,
    target_city TEXT
  );`);
  await runSql(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    total INTEGER,
    info TEXT,
    status TEXT,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );`);
  await runSql(`CREATE TABLE IF NOT EXISTS addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT,
    line TEXT,
    landmark TEXT,
    pin TEXT,
    city TEXT,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );`);

  // default admins
  const admins = [
    { email: 'admin@mummatiffin.com', pass: 'admin123', name: 'Super Admin', city: 'All' },
    { email: 'manager@mummatiffin.com', pass: 'manager123', name: 'City Manager', city: 'Delhi' }
  ];

  for (const a of admins) {
    const row = await getSql('SELECT id FROM admins WHERE email = ?', [a.email]);
    if (!row) {
      const hash = await bcrypt.hash(a.pass, 10);
      await runSql('INSERT INTO admins (email, password_hash, name, city, created_at) VALUES (?,?,?,?,?)',
        [a.email, hash, a.name, a.city, new Date().toISOString()]);
      console.log('Created admin', a.email);
    } else {
      console.log('Admin exists', a.email);
    }
  }

  // sample menu (only insert if not present)
  const anyMenu = await getSql('SELECT id FROM menu LIMIT 1');
  if (!anyMenu) {
    const sample = [
      ['b1','breakfast','Aloo Paratha + Curd','आलू पराठा + दही',60,'Hearty potato paratha','मज़ेदार आलू पराठा','Delhi','06:00','09:00',1],
      ['b2','breakfast','Poha + Tea','पोहा + चाय',45,'Light & tasty poha','हल्का और स्वादिष्ट पोहा','Pune','06:30','09:00',1],
      ['l1','lunch','Dal + Roti + Sabzi','दाल + रोटी + सब्ज़ी',85,'Balanced vegetarian meal','संतुलित शाकाहारी भोजन','All','11:00','14:00',1],
      ['d1','dinner','Khichdi + Papad','खिचड़ी + पापड़',70,'Comforting khichdi','आरामदेह खिचड़ी','All','18:00','20:00',1]
    ];
    for (const m of sample) {
      await runSql(`INSERT INTO menu (id,meal,name_en,name_hi,price,description_en,description_hi,city,available_from,available_to,active) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, m);
    }
    await runSql('INSERT INTO notifications (text, created_at, target_city) VALUES (?,?,?)', ['Welcome to Mumma Tiffin — live notifications enabled!', new Date().toISOString(), 'All']);
    console.log('Inserted sample menu and welcome notification');
  }
}

/* initialize DB on startup */
initDb().catch(err => {
  console.error('DB init failed', err);
});

/* -----------------------
   Auth helpers
   ----------------------- */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function verifyAuthHeader(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'missing authorization' });
  const parts = h.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'invalid authorization' });
  const token = parts[1];
  try {
    const data = jwt.verify(token, JWT_SECRET);
    req.user = data;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (role && req.user.role !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

/* -----------------------
   API Endpoints
   ----------------------- */

// Public: menu with optional city filter (only active items)
app.get('/api/menu', async (req, res) => {
  try {
    const city = req.query.city;
    const rows = await allSql('SELECT id,meal,name_en,name_hi,price,description_en,description_hi,city,available_from,available_to,active FROM menu ORDER BY meal, id');
    const filtered = rows.filter(r => r.active == 1 && (!city || r.city === city || r.city === 'All'));
    res.json({ menu: filtered });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Notifications (public)
app.get('/api/notifications', async (req, res) => {
  try {
    const rows = await allSql('SELECT id,text,created_at,target_city FROM notifications ORDER BY created_at DESC LIMIT 50');
    res.json({ notifications: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// User register
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email & password required' });
    const existing = await getSql('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(400).json({ error: 'user exists' });
    const hash = await bcrypt.hash(password, 10);
    await runSql('INSERT INTO users (email, password_hash, name, created_at) VALUES (?,?,?,?)', [email, hash, name || '', new Date().toISOString()]);
    const user = await getSql('SELECT id,email,name FROM users WHERE email = ?', [email]);
    const token = signToken({ id: user.id, email: user.email, role: 'user' });
    res.json({ user, token });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email & password required' });
    const user = await getSql('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(400).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'invalid credentials' });
    const token = signToken({ id: user.id, email: user.email, role: 'user' });
    res.json({ user: { id: user.id, email: user.email, name: user.name }, token });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const admin = await getSql('SELECT * FROM admins WHERE email = ?', [email]);
    if (!admin) return res.status(400).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) return res.status(400).json({ error: 'invalid credentials' });
    const token = signToken({ id: admin.id, email: admin.email, role: 'admin' });
    res.json({ admin: { id: admin.id, email: admin.email, name: admin.name, city: admin.city }, token });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Admin create other admins
app.post('/api/admin/create', verifyAuthHeader, requireRole('admin'), async (req, res) => {
  try {
    const { email, password, name, city } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email & password required' });
    const existing = await getSql('SELECT id FROM admins WHERE email = ?', [email]);
    if (existing) return res.status(400).json({ error: 'admin exists' });
    const hash = await bcrypt.hash(password, 10);
    await runSql('INSERT INTO admins (email, password_hash, name, city, created_at) VALUES (?,?,?,?,?)', [email, hash, name || '', city || 'All', new Date().toISOString()]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Admin list
app.get('/api/admin/list', verifyAuthHeader, requireRole('admin'), async (req, res) => {
  try {
    const rows = await allSql('SELECT id,email,name,city,created_at FROM admins ORDER BY id');
    res.json({ admins: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Admin menu CRUD
app.post('/api/admin/menu', verifyAuthHeader, requireRole('admin'), async (req, res) => {
  try {
    const { id, meal, name_en, name_hi, price, description_en, description_hi, city, available_from, available_to, active } = req.body;
    const iid = id || ('m' + Date.now());
    await runSql('INSERT INTO menu (id,meal,name_en,name_hi,price,description_en,description_hi,city,available_from,available_to,active) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [iid, meal, name_en, name_hi, price || 0, description_en || '', description_hi || '', city || 'All', available_from || '', available_to || '', active ? 1 : 0]);
    res.json({ ok: true, id: iid });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put('/api/admin/menu/:id', verifyAuthHeader, requireRole('admin'), async (req, res) => {
  try {
    const id = req.params.id;
    const fields = req.body;
    const updates = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    const vals = Object.values(fields);
    await runSql(`UPDATE menu SET ${updates} WHERE id = ?`, [...vals, id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete('/api/admin/menu/:id', verifyAuthHeader, requireRole('admin'), async (req, res) => {
  try {
    const id = req.params.id;
    await runSql('DELETE FROM menu WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Orders - create
app.post('/api/orders', verifyAuthHeader, requireRole('user'), async (req, res) => {
  try {
    const { items, total, address, date, time, meal } = req.body;
    if (!items || !address) return res.status(400).json({ error: 'items & address required' });
    const now = new Date().toISOString();
    const r = await runSql('INSERT INTO orders (user_id, total, info, status, created_at) VALUES (?,?,?,?,?)', [req.user.id, total || 0, JSON.stringify({ items, address, date, time, meal }), 'pending', now]);
    // Create a notification to inform admins / users
    await runSql('INSERT INTO notifications (text, created_at, target_city) VALUES (?,?,?)', [`New order ${r.lastID} placed`, new Date().toISOString(), address.city || 'All']);
    res.json({ ok: true, orderId: r.lastID });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Orders - user's own
app.get('/api/orders', verifyAuthHeader, requireRole('user'), async (req, res) => {
  try {
    const rows = await allSql('SELECT id,total,info,status,created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json({ orders: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Admin orders (view & update)
app.get('/api/admin/orders', verifyAuthHeader, requireRole('admin'), async (req, res) => {
  try {
    const admin = await getSql('SELECT * FROM admins WHERE id = ?', [req.user.id]);
    const rows = await allSql('SELECT o.id,o.user_id,o.total,o.info,o.status,o.created_at,u.email as user_email FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC');
    const filtered = rows.filter(r => {
      try {
        const info = JSON.parse(r.info || '{}'); const city = (info.address && info.address.city) ? info.address.city : 'All';
        return (admin.city === 'All' || admin.city === city || city === 'All');
      } catch (e) { return admin.city === 'All'; }
    });
    res.json({ orders: filtered });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put('/api/admin/orders/:id', verifyAuthHeader, requireRole('admin'), async (req, res) => {
  try {
    const id = req.params.id; const { status } = req.body;
    await runSql('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
    await runSql('INSERT INTO notifications (text, created_at, target_city) VALUES (?,?,?)', [`Order ${id} status updated → ${status}`, new Date().toISOString(), 'All']);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Addresses
app.post('/api/address', verifyAuthHeader, requireRole('user'), async (req, res) => {
  try {
    const { name, line, landmark, pin, city } = req.body;
    const now = new Date().toISOString();
    await runSql('INSERT INTO addresses (user_id,name,line,landmark,pin,city,created_at) VALUES (?,?,?,?,?,?,?)', [req.user.id, name || '', line || '', landmark || '', pin || '', city || '', now]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get('/api/address', verifyAuthHeader, requireRole('user'), async (req, res) => {
  try {
    const rows = await allSql('SELECT id,name,line,landmark,pin,city,created_at FROM addresses WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [req.user.id]);
    res.json({ addresses: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/* -----------------------
   Embedded frontend
   ----------------------- */
const frontendHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Mumma Tiffin</title>
<style>
:root{--bg:#f6f7fb;--card:#fff;--text:#0f1724;--muted:#546077;--accent:#ff5a5f}
[data-theme="dark"]{--bg:#071026;--card:#071021;--text:#e6eef8;--muted:#9fb0c8;--accent:#ff8b8f}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Arial;background:var(--bg);color:var(--text);padding:12px}
.container{max-width:1100px;margin:12px auto}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.logo{display:flex;gap:12px;align-items:center}
.logo img{width:56px;height:56px;border-radius:12px}
.controls{display:flex;gap:8px;align-items:center}
.btn{background:var(--accent);color:#fff;padding:8px 12px;border-radius:10px;border:0;cursor:pointer}
.card{background:var(--card);padding:14px;border-radius:12px;box-shadow:0 8px 24px rgba(2,6,23,0.06);margin-top:12px}
.grid{display:grid;grid-template-columns:1fr 360px;gap:12px}
@media(max-width:980px){.grid{grid-template-columns:1fr}}
.small{font-size:13px;color:var(--muted)}
.tabs{display:flex;gap:8px}
.tab{padding:8px 12px;border-radius:8px;border:1px solid rgba(0,0,0,0.06);cursor:pointer}
.hidden{display:none}
.table{width:100%;border-collapse:collapse}
.table th,.table td{padding:8px;border-bottom:1px solid rgba(0,0,0,0.06);text-align:left}
.input,select{padding:8px;border-radius:8px;border:1px solid rgba(0,0,0,0.08);width:100%}
.toast{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#fff;padding:12px 18px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.12);z-index:9999;display:flex;gap:12px;align-items:center}
</style>
</head><body>
<div id="splash" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(3,7,18,0.9);color:#fff;flex-direction:column;z-index:9999">
  <div style="font-size:28px;font-weight:800">Mumma Tiffin</div>
  <div class="small">Multi-city • Multi-admin • Live orders</div>
</div>

<div class="container">
  <div class="top">
    <div class="logo">
      <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='4' y='4' width='56' height='56' rx='10' fill='%23fff'/%3E%3Cpath d='M20 37c2-6 9-9 14-9s12 3 13 9' stroke='%23ff5a5f' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E" alt="logo"/>
      <div>
        <div style="font-weight:800">Mumma Tiffin</div>
        <div class="small">Homely meals across India</div>
      </div>
    </div>
    <div class="controls">
      <select id="citySel" class="input" style="width:160px"><option value="">All cities</option><option>Delhi</option><option>Pune</option><option>Mumbai</option></select>
      <button id="adminToggle" class="btn">Admin Login</button>
      <button id="themeBtn" class="btn">Toggle Theme</button>
    </div>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div><strong>User Portal</strong> — browse & order</div>
      <div class="small">Book before cutoff times</div>
    </div>

    <div class="grid">
      <main>
        <div style="margin-top:12px" id="menuArea"><em class="small">Loading menu...</em></div>
        <div class="card">
          <h3>Your Cart</h3>
          <div id="cartList" class="small">Empty</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button id="checkoutBtn" class="btn">Checkout</button>
          </div>
        </div>
      </main>

      <aside>
        <div class="card">
          <h3>Login / Register</h3>
          <div id="authArea"></div>
        </div>
        <div class="card">
          <h3>Notifications</h3>
          <div id="notifs" class="small">-</div>
        </div>
      </aside>
    </div>
  </div>

  <div id="adminPanel" class="card hidden">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div><strong>Admin Dashboard</strong></div>
      <div><button id="adminLogout" class="btn">Logout Admin</button></div>
    </div>

    <div style="margin-top:12px" class="tabs">
      <div class="tab" data-tab="menu">Menu</div>
      <div class="tab" data-tab="orders">Orders</div>
      <div class="tab" data-tab="notifs">Notifications</div>
      <div class="tab" data-tab="admins">Admins</div>
    </div>

    <div id="adminMenu" class="card hidden">
      <h4>Manage Menu</h4>
      <table class="table" id="menuTable"><thead><tr><th>ID</th><th>Meal</th><th>Name (EN)</th><th>City</th><th>Price</th><th>Active</th><th></th></tr></thead><tbody></tbody></table>
      <div style="margin-top:8px">
        <h5>Add / Edit Item</h5>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <input id="m_id" class="input" placeholder="id (leave blank to auto)"/>
          <select id="m_meal" class="input"><option value="breakfast">Breakfast</option><option value="lunch">Lunch</option><option value="dinner">Dinner</option></select>
          <input id="m_name_en" class="input" placeholder="Name (English)"/>
          <input id="m_city" class="input" placeholder="City (e.g. Delhi or All)"/>
          <input id="m_price" class="input" placeholder="Price"/>
          <select id="m_active" class="input"><option value="1">Active</option><option value="0">Inactive</option></select>
        </div>
        <div style="margin-top:8px;display:flex;gap:8px">
          <button id="m_save" class="btn">Save</button>
          <button id="m_clear" class="btn">Clear</button>
        </div>
      </div>
    </div>

    <div id="adminOrders" class="card hidden">
      <h4>Orders</h4>
      <table class="table" id="ordersTable"><thead><tr><th>ID</th><th>User</th><th>Total</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody></tbody></table>
    </div>

    <div id="adminNotifs" class="card hidden">
      <h4>Notifications</h4>
      <div style="display:flex;gap:8px">
        <input id="notifText" class="input" placeholder="Notification text"/>
        <input id="notifCity" class="input" placeholder="Target city (All)"/>
        <button id="notifSend" class="btn">Send</button>
      </div>
      <div id="adminNotifList" style="margin-top:8px" class="small"></div>
    </div>

    <div id="adminAdmins" class="card hidden">
      <h4>Admins</h4>
      <table class="table" id="adminsTable"><thead><tr><th>ID</th><th>Email</th><th>Name</th></tr></thead><tbody></tbody></table>
      <div style="margin-top:8px;display:flex;gap:8px">
        <input id="newAdminEmail" class="input" placeholder="Email"/>
        <input id="newAdminPass" class="input" placeholder="Password"/>
        <input id="newAdminName" class="input" placeholder="Name"/>
        <button id="createAdminBtn" class="btn">Create Admin</button>
      </div>
    </div>
  </div>

  <div class="small" style="margin-top:12px">© Mumma Tiffin</div>
</div>

<script>
/* Frontend SPA — communicates with the same server */
const API = '';
let state = { token:null, adminToken:null, cart:[], user:null };
const $ = id => document.getElementById(id);

window.addEventListener('load', ()=>{ setTimeout(()=>document.getElementById('splash').style.display='none', 1200); loadMenu(); loadNotifs(); renderAuth(); });

document.getElementById('themeBtn').addEventListener('click', ()=>{ document.documentElement.toggleAttribute('data-theme','dark'); });
document.getElementById('citySel').addEventListener('change', ()=> loadMenu());
document.getElementById('adminToggle').addEventListener('click', ()=> openAdminLogin());
document.getElementById('adminLogout').addEventListener('click', ()=>{ state.adminToken=null; document.getElementById('adminPanel').classList.add('hidden'); });

function authHeader(token){ return token? { 'Authorization':'Bearer '+token } : {}; }

/* ---- Menu for users ---- */
async function loadMenu(){
  const city = document.getElementById('citySel').value;
  const res = await fetch('/api/menu'+(city? '?city='+encodeURIComponent(city):''));
  const data = await res.json();
  const area = document.getElementById('menuArea'); area.innerHTML='';
  if(!data.menu || data.menu.length===0){ area.innerHTML = '<div class="small">No menu.</div>'; return; }
  data.menu.forEach(it=>{
    const div = document.createElement('div'); div.className='card';
    div.innerHTML = `<div style="display:flex;justify-content:space-between">
      <div><strong>${it.name_en}</strong><div class="small">${it.meal} · ${it.city}</div></div>
      <div><div style="font-weight:800">₹${it.price}</div><button class="btn" data-id="${it.id}">Add</button></div>
    </div>`;
    area.appendChild(div);
  });
  area.querySelectorAll('button[data-id]').forEach(b=>b.addEventListener('click', async e=>{
    const id = e.currentTarget.dataset.id;
    const it = data.menu.find(x=>x.id===id);
    state.cart.push({...it, qty:1});
    renderCart();
  }));
}

/* ---- Cart ---- */
function renderCart(){
  const el = document.getElementById('cartList'); if(state.cart.length===0){ el.innerText='Empty'; return; }
  el.innerHTML = state.cart.map((c,i)=>`<div>${c.name_en} x ${c.qty} — ₹${c.price} <button data-i="${i}" class="btn">Remove</button></div>`).join('');
  el.querySelectorAll('button[data-i]').forEach(b=>b.addEventListener('click', e=>{ state.cart.splice(Number(e.currentTarget.dataset.i),1); renderCart(); }));
}

/* ---- Auth UI ---- */
function renderAuth(){
  const area = document.getElementById('authArea'); area.innerHTML='';
  if(!state.user){
    area.innerHTML = `<input id="u_email" class="input" placeholder="Email"/><input id="u_pass" type="password" class="input" placeholder="Password" style="margin-top:8px"/><div style="display:flex;gap:8px;margin-top:8px"><button id="loginBtn" class="btn">Login</button><button id="regBtn" class="btn">Register</button></div>`;
    document.getElementById('loginBtn').addEventListener('click', loginUser);
    document.getElementById('regBtn').addEventListener('click', registerUser);
  } else {
    area.innerHTML = `<div class="small">Hello, ${state.user.name||state.user.email}</div><div style="margin-top:8px"><button id="logoutBtn" class="btn">Logout</button></div>`;
    document.getElementById('logoutBtn').addEventListener('click', ()=>{ state.user=null; state.token=null; localStorage.removeItem('mumma_user'); renderAuth(); });
  }
}

async function registerUser(){
  const email = document.getElementById('u_email').value, pass = document.getElementById('u_pass').value;
  if(!email||!pass){ alert('email & password'); return; }
  const res = await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pass,name:''})});
  const j = await res.json(); if(j.token){ state.user=j.user; state.token=j.token; localStorage.setItem('mumma_user', JSON.stringify(j)); renderAuth(); alert('Registered'); } else alert(j.error||'Error');
}
async function loginUser(){
  const email = document.getElementById('u_email').value, pass = document.getElementById('u_pass').value;
  const res = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pass})});
  const j = await res.json(); if(j.token){ state.user=j.user; state.token=j.token; localStorage.setItem('mumma_user', JSON.stringify(j)); renderAuth(); alert('Logged in'); } else alert(j.error||'Error');
}

/* ---- Checkout (creates order) ---- */
document.getElementById('checkoutBtn').addEventListener('click', async ()=>{
  if(state.cart.length===0){ alert('Cart empty'); return; }
  if(!state.token){ alert('Please login'); return; }
  const addr = { name:'Guest', line:'N/A', landmark:'N/A', pin:'000000', city: document.getElementById('citySel').value || 'All' };
  const body = { items: state.cart, total: state.cart.reduce((s,i)=>s+i.price,0), address: addr, date: new Date().toISOString().slice(0,10), time: new Date().toTimeString().slice(0,5), meal: state.cart[0].meal };
  const res = await fetch('/api/orders',{method:'POST',headers:Object.assign({'Content-Type':'application/json'}, authHeader(state.token)), body: JSON.stringify(body)});
  const j = await res.json(); if(j.ok){ showToast('Order placed — admins notified'); state.cart=[]; renderCart(); } else alert(j.error||'Error');
});

/* ---- Notifications ---- */
async function loadNotifs(){
  const res = await fetch('/api/notifications'); const j = await res.json();
  const el = document.getElementById('notifs'); if(!j.notifications) { el.innerText='-'; return; }
  el.innerHTML = j.notifications.slice(0,5).map(n=>`<div>${n.text}</div>`).join('');
  if(j.notifications && j.notifications.length){ showToast(j.notifications[0].text); }
}

function showToast(text){ const t = document.createElement('div'); t.className='toast'; t.innerHTML = `<strong>Notice</strong><div>${text}</div>`; document.body.appendChild(t); setTimeout(()=>{ t.style.opacity=1; },50); setTimeout(()=>{ t.remove(); },6000); }

/* ---- Admin flow ---- */
function openAdminLogin(){ const email = prompt('Admin email (default admin@mummatiffin.com)'); const pass = prompt('Admin password (default admin123)'); if(!email||!pass) return; fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pass})}).then(r=>r.json()).then(j=>{ if(j.admin || j.token){ state.adminToken=j.token || j.admin?.token; showAdminPanel(); alert('Admin logged'); } else alert(j.error||'Admin login failed'); }); }
function showAdminPanel(){ document.getElementById('adminPanel').classList.remove('hidden'); loadAdminMenu(); loadAdminOrders(); loadAdminNotifs(); loadAdmins(); selectTab('menu'); }

document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',(e)=> selectTab(e.currentTarget.dataset.tab)));
function selectTab(name){ document.getElementById('adminMenu').classList.toggle('hidden', name!=='menu'); document.getElementById('adminOrders').classList.toggle('hidden', name!=='orders'); document.getElementById('adminNotifs').classList.toggle('hidden', name!=='notifs'); document.getElementById('adminAdmins').classList.toggle('hidden', name!=='admins'); }

async function loadAdminMenu(){ const res = await fetch('/api/menu'); const j = await res.json(); const tbody = document.querySelector('#menuTable tbody'); tbody.innerHTML=''; j.menu.forEach(it=>{ const tr = document.createElement('tr'); tr.innerHTML = `<td>${it.id}</td><td>${it.meal}</td><td>${it.name_en}</td><td>${it.city}</td><td>₹${it.price}</td><td>${it.active==1?'Yes':'No'}</td><td><button class="btn" data-id="${it.id}">Edit</button> <button class="btn" data-del="${it.id}">Delete</button></td>`; tbody.appendChild(tr); }); tbody.querySelectorAll('button[data-id]').forEach(b=>b.addEventListener('click', e=> editMenuItem(e.currentTarget.dataset.id, j.menu.find(x=>x.id===e.currentTarget.dataset.id)))); tbody.querySelectorAll('button[data-del]').forEach(b=>b.addEventListener('click', async e=>{ if(!confirm('Delete?')) return; const id=e.currentTarget.dataset.del; await fetch('/api/admin/menu/'+id,{method:'DELETE',headers:authHeader(state.adminToken)}); loadAdminMenu(); })); }
function editMenuItem(id,item){ document.getElementById('m_id').value=item.id; document.getElementById('m_meal').value=item.meal; document.getElementById('m_name_en').value=item.name_en; document.getElementById('m_city').value=item.city; document.getElementById('m_price').value=item.price; document.getElementById('m_active').value=item.active; }
document.getElementById('m_save').addEventListener('click', async ()=>{ const payload = { id: document.getElementById('m_id').value || undefined, meal: document.getElementById('m_meal').value, name_en: document.getElementById('m_name_en').value, city: document.getElementById('m_city').value || 'All', price: Number(document.getElementById('m_price').value)||0, active: Number(document.getElementById('m_active').value) }; if(payload.id){ await fetch('/api/admin/menu/'+payload.id, { method:'PUT', headers: Object.assign({'Content-Type':'application/json'}, authHeader(state.adminToken)), body: JSON.stringify(payload) }); } else { await fetch('/api/admin/menu', { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, authHeader(state.adminToken)), body: JSON.stringify(payload) }); } loadAdminMenu(); });

async function loadAdminOrders(){ const res = await fetch('/api/admin/orders', { headers: authHeader(state.adminToken) }); const j = await res.json(); const tbody = document.querySelector('#ordersTable tbody'); tbody.innerHTML=''; j.orders.forEach(o=>{ const tr = document.createElement('tr'); tr.innerHTML = `<td>${o.id}</td><td>${o.user_email||o.user_id}</td><td>₹${o.total}</td><td>${o.status}</td><td>${new Date(o.created_at).toLocaleString()}</td><td><select data-id="${o.id}"><option>pending</option><option>preparing</option><option>out for delivery</option><option>delivered</option></select></td>`; tbody.appendChild(tr); }); tbody.querySelectorAll('select[data-id]').forEach(s=>s.addEventListener('change', async e=>{ const id = e.currentTarget.dataset.id; const status = e.currentTarget.value; await fetch('/api/admin/orders/'+id, { method:'PUT', headers: Object.assign({'Content-Type':'application/json'}, authHeader(state.adminToken)), body: JSON.stringify({status}) }); loadAdminOrders(); })); }

document.getElementById('notifSend').addEventListener('click', async ()=>{ const text=document.getElementById('notifText').value; const city=document.getElementById('notifCity').value||'All'; if(!text) return alert('text'); await fetch('/api/admin/notifications', { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, authHeader(state.adminToken)), body: JSON.stringify({text, target_city: city}) }); document.getElementById('notifText').value=''; loadAdminNotifs(); loadNotifs(); });
async function loadAdminNotifs(){ const res = await fetch('/api/notifications'); const j = await res.json(); document.getElementById('adminNotifList').innerHTML = j.notifications.map(n=>`<div>${n.text} <small>${new Date(n.created_at).toLocaleString()}</small></div>`).join(''); }

async function loadAdmins(){ const res = await fetch('/api/admin/list', { headers: authHeader(state.adminToken) }); const j = await res.json(); const tbody = document.querySelector('#adminsTable tbody'); tbody.innerHTML=''; j.admins.forEach(a=>{ const tr = document.createElement('tr'); tr.innerHTML = `<td>${a.id}</td><td>${a.email}</td><td>${a.name}</td>`; tbody.appendChild(tr); }); }
document.getElementById('createAdminBtn').addEventListener('click', async ()=>{ const email=document.getElementById('newAdminEmail').value; const pass=document.getElementById('newAdminPass').value; const name=document.getElementById('newAdminName').value; if(!email||!pass) return alert('email & pass'); await fetch('/api/admin/create', { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, authHeader(state.adminToken)), body: JSON.stringify({email,password:pass,name}) }); loadAdmins(); alert('Created'); });

</script></body></html>`;

/* Serve frontend */
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(frontendHtml);
});

/* Fallback for SPA paths */
app.get('/app/*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(frontendHtml);
});

/* Start server */
app.listen(PORT, () => {
  console.log(`Mumma Tiffin running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
