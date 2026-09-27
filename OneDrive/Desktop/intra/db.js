// Lightweight file-based JSON "database" — no external DB server needed.
// Good enough for an intranet deployment / academic project; swap for
// MySQL/MongoDB later if you need multi-process scaling.
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

function defaultData() {
  return {
    users: [],      // { id, username, email, passwordHash }
    contacts: [],   // { userA, userB }  (mutual contact link)
    groups: [],     // { id, name, members: [username, ...], createdBy }
    messages: []    // { id, type: 'private'|'group', from, to, groupId, text, fileUrl, fileName, ts }
  };
}

function load() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData(), null, 2));
  }
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return defaultData();
  }
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let cache = load();

function getDb() {
  return cache;
}

function persist() {
  save(cache);
}

module.exports = { getDb, persist };
