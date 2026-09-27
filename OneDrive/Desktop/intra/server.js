const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');
const { getDb, persist } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// ---------- File upload config ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB cap

// ---------- Auth helpers ----------
function signToken(user) {
  return jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.username = payload.username;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function findUser(username) {
  const db = getDb();
  return db.users.find(u => u.username === username || u.email === username);
}

// ---------- Auth routes ----------
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }
  const db = getDb();
  if (db.users.some(u => u.username === username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  if (db.users.some(u => u.email === email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const user = { id: crypto.randomUUID(), username, email, passwordHash };
  db.users.push(user);
  persist();
  const token = signToken(user);
  res.json({ token, username: user.username });
});

app.post('/api/login', (req, res) => {
  const { usernameOrEmail, password } = req.body || {};
  if (!usernameOrEmail || !password) {
    return res.status(400).json({ error: 'Username/email and password are required' });
  }
  const user = findUser(usernameOrEmail);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = signToken(user);
  res.json({ token, username: user.username });
});

// ---------- Profile ----------
app.get('/api/profile', authMiddleware, (req, res) => {
  const user = findUser(req.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ username: user.username, email: user.email });
});

app.put('/api/profile', authMiddleware, (req, res) => {
  const { email, password } = req.body || {};
  const db = getDb();
  const user = db.users.find(u => u.username === req.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (email) user.email = email;
  if (password) user.passwordHash = bcrypt.hashSync(password, 10);
  persist();
  res.json({ ok: true, username: user.username, email: user.email });
});

// ---------- Contacts ----------
app.get('/api/contacts', authMiddleware, (req, res) => {
  const db = getDb();
  const names = new Set();
  db.contacts.forEach(c => {
    if (c.userA === req.username) names.add(c.userB);
    if (c.userB === req.username) names.add(c.userA);
  });
  const online = getOnlineUsers();
  const list = [...names].map(username => ({
    username,
    online: online.has(username)
  }));
  res.json(list);
});

app.post('/api/contacts', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (username === req.username) return res.status(400).json({ error: "You can't add yourself" });
  const db = getDb();
  const target = db.users.find(u => u.username === username);
  if (!target) return res.status(404).json({ error: 'No such user' });
  const exists = db.contacts.some(c =>
    (c.userA === req.username && c.userB === username) ||
    (c.userB === req.username && c.userA === username)
  );
  if (!exists) {
    db.contacts.push({ userA: req.username, userB: username });
    persist();
  }
  res.json({ ok: true });
});

// ---------- Groups ----------
app.get('/api/groups', authMiddleware, (req, res) => {
  const db = getDb();
  const list = db.groups
    .filter(g => g.members.includes(req.username))
    .map(g => ({ id: g.id, name: g.name, members: g.members }));
  res.json(list);
});

app.post('/api/groups', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const db = getDb();
  const group = {
    id: crypto.randomUUID(),
    name,
    members: [req.username],
    createdBy: req.username
  };
  db.groups.push(group);
  persist();
  res.json(group);
});

app.post('/api/groups/:id/members', authMiddleware, (req, res) => {
  const { username } = req.body || {};
  const db = getDb();
  const group = db.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.members.includes(req.username)) {
    return res.status(403).json({ error: 'You are not a member of this group' });
  }
  const target = db.users.find(u => u.username === username);
  if (!target) return res.status(404).json({ error: 'No such user' });
  if (!group.members.includes(username)) {
    group.members.push(username);
    persist();
    io.to(roomForGroup(group.id)).emit('group members updated', { groupId: group.id, members: group.members });
  }
  res.json({ ok: true, members: group.members });
});

// ---------- Message history ----------
app.get('/api/messages/private/:username', authMiddleware, (req, res) => {
  const other = req.params.username;
  const db = getDb();
  const history = db.messages.filter(m =>
    m.type === 'private' &&
    ((m.from === req.username && m.to === other) || (m.from === other && m.to === req.username))
  );
  res.json(history);
});

app.get('/api/messages/group/:groupId', authMiddleware, (req, res) => {
  const db = getDb();
  const group = db.groups.find(g => g.id === req.params.groupId);
  if (!group || !group.members.includes(req.username)) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }
  const history = db.messages.filter(m => m.type === 'group' && m.groupId === req.params.groupId);
  res.json(history);
});

// ---------- File upload ----------
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    fileUrl: '/uploads/' + req.file.filename,
    fileName: req.file.originalname
  });
});

// ============ Socket.io real-time layer ============
const onlineSockets = new Map(); // username -> Set of socket ids

function getOnlineUsers() {
  return new Set(onlineSockets.keys());
}

function roomForGroup(groupId) {
  return 'group:' + groupId;
}

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('No auth token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.username = payload.username;
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const username = socket.username;

  if (!onlineSockets.has(username)) onlineSockets.set(username, new Set());
  onlineSockets.get(username).add(socket.id);

  // join every group room this user belongs to
  const db = getDb();
  db.groups.filter(g => g.members.includes(username)).forEach(g => {
    socket.join(roomForGroup(g.id));
  });

  io.emit('presence', { username, online: true });

  socket.on('private message', ({ to, text }) => {
    if (!to || !text) return;
    const msg = {
      id: crypto.randomUUID(),
      type: 'private',
      from: username,
      to,
      text,
      ts: Date.now()
    };
    getDb().messages.push(msg);
    persist();
    // send to recipient's sockets, and echo back to sender's other sockets
    (onlineSockets.get(to) || []).forEach(sid => io.to(sid).emit('private message', msg));
    (onlineSockets.get(username) || []).forEach(sid => io.to(sid).emit('private message', msg));
  });

  socket.on('group message', ({ groupId, text }) => {
    if (!groupId || !text) return;
    const group = getDb().groups.find(g => g.id === groupId);
    if (!group || !group.members.includes(username)) return;
    const msg = {
      id: crypto.randomUUID(),
      type: 'group',
      from: username,
      groupId,
      text,
      ts: Date.now()
    };
    getDb().messages.push(msg);
    persist();
    io.to(roomForGroup(groupId)).emit('group message', msg);
  });

  socket.on('private file', ({ to, fileUrl, fileName }) => {
    if (!to || !fileUrl) return;
    const msg = {
      id: crypto.randomUUID(),
      type: 'private',
      from: username,
      to,
      fileUrl,
      fileName,
      ts: Date.now()
    };
    getDb().messages.push(msg);
    persist();
    (onlineSockets.get(to) || []).forEach(sid => io.to(sid).emit('private message', msg));
    (onlineSockets.get(username) || []).forEach(sid => io.to(sid).emit('private message', msg));
  });

  socket.on('group file', ({ groupId, fileUrl, fileName }) => {
    const group = getDb().groups.find(g => g.id === groupId);
    if (!group || !group.members.includes(username)) return;
    const msg = {
      id: crypto.randomUUID(),
      type: 'group',
      from: username,
      groupId,
      fileUrl,
      fileName,
      ts: Date.now()
    };
    getDb().messages.push(msg);
    persist();
    io.to(roomForGroup(groupId)).emit('group message', msg);
  });

  socket.on('join group room', (groupId) => {
    const group = getDb().groups.find(g => g.id === groupId);
    if (group && group.members.includes(username)) socket.join(roomForGroup(groupId));
  });

  socket.on('disconnect', () => {
    const set = onlineSockets.get(username);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineSockets.delete(username);
        io.emit('presence', { username, online: false });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Intranet chat app running at http://localhost:${PORT}`);
});
