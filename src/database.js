const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'seminar.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  const database = db;

  // Settings table
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Insert default settings
  const insertSetting = database.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
  `);
  insertSetting.run('max_capacity', '120');
  insertSetting.run('seminar_title', '라스북 학부모 세미나');
  insertSetting.run('seminar_date', '2025년 8월 23일 (토) 오전 10:00');
  insertSetting.run('seminar_venue', '라스북 교육문화센터 대강당');
  insertSetting.run('admin_password', 'lasbook2025');

  // Registrations table
  database.exec(`
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      organization TEXT NOT NULL,
      referrer TEXT,
      ticket_code TEXT UNIQUE NOT NULL,
      registered_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      attended INTEGER NOT NULL DEFAULT 0,
      attended_at TEXT
    )
  `);

  // Index for fast lookups
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_ticket_code ON registrations(ticket_code);
    CREATE INDEX IF NOT EXISTS idx_phone ON registrations(phone);
  `);
}

module.exports = { getDb };
