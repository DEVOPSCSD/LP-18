// ===================== State =====================
let token = localStorage.getItem('chat_token') || null;
let me = localStorage.getItem('chat_username') || null;
let socket = null;

let contacts = [];   // [{username, online}]
let groups = [];      // [{id, name, members}]
let current = null;   // {type: 'private'|'group', id: username|groupId, label}

// ===================== Helpers =====================
function $(id) { return document.getElementById(id); }

function showView(id) {
  ['view-register', 'view-login', 'view-dashboard', 'view-profile'].forEach(v => {
    $(v).classList.toggle('hidden', v !== id);
  });
}

async function api(path, method = 'GET', body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch('/api' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ===================== Boot =====================
if (token && me) {
  connectSocket();
  enterDashboard();
} else {
  showView('view-register');
}

// ===================== Register / Login switching =====================
$('link-to-login').onclick = (e) => { e.preventDefault(); showView('view-login'); };
$('link-to-register').onclick = (e) => { e.preventDefault(); showView('view-register'); };

// ===================== Register =====================
$('btn-register').onclick = async () => {
  $('reg-error').textContent = '';
  const username = $('reg-username').value.trim();
  const email = $('reg-email').value.trim();
  const password = $('reg-password').value;
  if (!username || !email || !password) {
    $('reg-error').textContent = 'Please fill out all fields.';
    return;
  }
  try {
    const data = await api('/register', 'POST', { username, email, password });
    token = data.token; me = data.username;
    localStorage.setItem('chat_token', token);
    localStorage.setItem('chat_username', me);
    connectSocket();
    enterDashboard();
  } catch (e) {
    $('reg-error').textContent = e.message;
  }
};

// ===================== Login =====================
$('btn-login').onclick = async () => {
  $('login-error').textContent = '';
  const usernameOrEmail = $('login-username').value.trim();
  const password = $('login-password').value;
  if (!usernameOrEmail || !password) {
    $('login-error').textContent = 'Please fill out this field.';
    return;
  }
  try {
    const data = await api('/login', 'POST', { usernameOrEmail, password });
    token = data.token; me = data.username;
    localStorage.setItem('chat_token', token);
    localStorage.setItem('chat_username', me);
    connectSocket();
    enterDashboard();
  } catch (e) {
    $('login-error').textContent = e.message;
  }
};

// ===================== Logout =====================
function doLogout() {
  localStorage.removeItem('chat_token');
  localStorage.removeItem('chat_username');
  token = null; me = null;
  if (socket) socket.disconnect();
  current = null;
  showView('view-login');
}
$('link-logout').onclick = (e) => { e.preventDefault(); doLogout(); };
$('link-logout-2').onclick = (e) => { e.preventDefault(); doLogout(); };

// ===================== Profile =====================
$('link-profile').onclick = async (e) => {
  e.preventDefault();
  try {
    const p = await api('/profile');
    $('profile-email').value = p.email;
    $('profile-password').value = '';
    $('profile-error').textContent = '';
    $('profile-success').textContent = '';
    showView('view-profile');
  } catch (e) {
    doLogout();
  }
};

$('link-back-dashboard').onclick = (e) => { e.preventDefault(); showView('view-dashboard'); };

$('btn-update-profile').onclick = async () => {
  $('profile-error').textContent = '';
  $('profile-success').textContent = '';
  const email = $('profile-email').value.trim();
  const password = $('profile-password').value;
  try {
    await api('/profile', 'PUT', { email, password: password || undefined });
    $('profile-success').textContent = 'Profile updated successfully.';
  } catch (e) {
    $('profile-error').textContent = e.message;
  }
};

// ===================== Dashboard entry =====================
async function enterDashboard() {
  $('me-username').textContent = me;
  showView('view-dashboard');
  await Promise.all([loadContacts(), loadGroups()]);
}

async function loadContacts() {
  contacts = await api('/contacts');
  renderContacts();
}

async function loadGroups() {
  groups = await api('/groups');
  renderGroups();
}

function renderContacts() {
  const ul = $('contacts-list');
  ul.innerHTML = '';
  contacts.forEach(c => {
    const li = document.createElement('li');
    li.className = current && current.type === 'private' && current.id === c.username ? 'active' : '';
    li.innerHTML = `<span>${escapeHtml(c.username)}</span>
      <span class="status-badge ${c.online ? 'online' : 'offline'}">${c.online ? 'online' : 'offline'}</span>`;
    li.onclick = () => openPrivateChat(c.username);
    ul.appendChild(li);
  });
}

function renderGroups() {
  const ul = $('groups-list');
  ul.innerHTML = '';
  groups.forEach(g => {
    const li = document.createElement('li');
    li.className = current && current.type === 'group' && current.id === g.id ? 'active' : '';
    li.innerHTML = `<span># ${escapeHtml(g.name)} (${g.members.length})</span>`;
    li.onclick = () => openGroupChat(g);
    ul.appendChild(li);
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ===================== Add contact / create group =====================
$('btn-add-contact').onclick = async () => {
  const username = $('add-contact-input').value.trim();
  if (!username) return;
  try {
    await api('/contacts', 'POST', { username });
    $('add-contact-input').value = '';
    await loadContacts();
  } catch (e) {
    alert(e.message);
  }
};

$('btn-new-group').onclick = async () => {
  const name = $('new-group-input').value.trim();
  if (!name) return;
  try {
    const group = await api('/groups', 'POST', { name });
    $('new-group-input').value = '';
    if (socket) socket.emit('join group room', group.id);
    await loadGroups();
  } catch (e) {
    alert(e.message);
  }
};

// ===================== Opening chats =====================
async function openPrivateChat(username) {
  current = { type: 'private', id: username, label: 'Chat with ' + username };
  $('chat-title').textContent = current.label;
  $('group-add-member').classList.add('hidden');
  $('composer').classList.remove('hidden');
  renderContacts(); renderGroups();
  const history = await api('/messages/private/' + encodeURIComponent(username));
  renderMessages(history);
}

async function openGroupChat(group) {
  current = { type: 'group', id: group.id, label: `Group: ${group.name} (${group.members.length} members)` };
  $('chat-title').textContent = current.label;
  $('group-add-member').classList.remove('hidden');
  $('composer').classList.remove('hidden');
  renderContacts(); renderGroups();
  if (socket) socket.emit('join group room', group.id);
  const history = await api('/messages/group/' + group.id);
  renderMessages(history);
}

$('btn-add-member').onclick = async () => {
  if (!current || current.type !== 'group') return;
  const username = $('group-member-input').value.trim();
  if (!username) return;
  try {
    const res = await api(`/groups/${current.id}/members`, 'POST', { username });
    $('group-member-input').value = '';
    const g = groups.find(g => g.id === current.id);
    if (g) g.members = res.members;
    $('chat-title').textContent = `Group: ${g.name} (${g.members.length} members)`;
    renderGroups();
  } catch (e) {
    alert(e.message);
  }
};

// ===================== Rendering messages =====================
function renderMessages(list) {
  const box = $('messages');
  box.innerHTML = '';
  list.forEach(appendMessage);
  box.scrollTop = box.scrollHeight;
}

function appendMessage(msg) {
  const box = $('messages');
  const mine = msg.from === me;
  const div = document.createElement('div');
  div.className = 'msg ' + (mine ? 'mine' : 'theirs');
  let body = '';
  if (msg.text) body = escapeHtml(msg.text);
  if (msg.fileUrl) {
    body += `<br/><a class="file-link" href="${msg.fileUrl}" target="_blank" rel="noopener">📎 ${escapeHtml(msg.fileName || 'file')}</a>`;
  }
  div.innerHTML = `${msg.type === 'group' && !mine ? `<span class="msg-sender">${escapeHtml(msg.from)}</span>` : ''}
    ${body}<span class="msg-time">${fmtTime(msg.ts)}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function messageBelongsToCurrentView(msg) {
  if (!current) return false;
  if (current.type === 'private' && msg.type === 'private') {
    return (msg.from === current.id && msg.to === me) || (msg.from === me && msg.to === current.id);
  }
  if (current.type === 'group' && msg.type === 'group') {
    return msg.groupId === current.id;
  }
  return false;
}

// ===================== Sending =====================
$('btn-send').onclick = sendMessage;
$('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
  if (!current) return;
  const text = $('message-input').value.trim();
  if (!text) return;
  if (current.type === 'private') {
    socket.emit('private message', { to: current.id, text });
  } else {
    socket.emit('group message', { groupId: current.id, text });
  }
  $('message-input').value = '';
}

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !current) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    if (current.type === 'private') {
      socket.emit('private file', { to: current.id, fileUrl: data.fileUrl, fileName: data.fileName });
    } else {
      socket.emit('group file', { groupId: current.id, fileUrl: data.fileUrl, fileName: data.fileName });
    }
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.value = '';
  }
});

// ===================== Socket.io =====================
function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('connect_error', () => doLogout());

  socket.on('presence', ({ username, online }) => {
    const c = contacts.find(c => c.username === username);
    if (c) { c.online = online; renderContacts(); }
  });

  socket.on('private message', (msg) => {
    if (messageBelongsToCurrentView(msg)) appendMessage(msg);
  });

  socket.on('group message', (msg) => {
    if (messageBelongsToCurrentView(msg)) appendMessage(msg);
  });

  socket.on('group members updated', ({ groupId, members }) => {
    const g = groups.find(g => g.id === groupId);
    if (g) {
      g.members = members;
      if (current && current.type === 'group' && current.id === groupId) {
        $('chat-title').textContent = `Group: ${g.name} (${members.length} members)`;
      }
      renderGroups();
    }
  });
}
