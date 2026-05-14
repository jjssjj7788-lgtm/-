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
  const d = db;

  // ── 전역 설정 ─────────────────────────────────────────────────────────────
  d.exec(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  const set = d.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`);
  set.run('admin_password', 'lasbook2025');
  set.run('org_name', '라스북');

  // ── 이벤트 (세미나/교육 1건) ──────────────────────────────────────────────
  d.exec(`CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    category     TEXT    NOT NULL DEFAULT '세미나',   -- 세미나|직무연수|교육|기타
    event_date   TEXT    NOT NULL,                   -- YYYY-MM-DD
    venue        TEXT    NOT NULL DEFAULT '',
    description  TEXT    NOT NULL DEFAULT '',
    max_capacity INTEGER NOT NULL DEFAULT 120,
    is_active    INTEGER NOT NULL DEFAULT 1,
    color        TEXT    NOT NULL DEFAULT '#1B2B4B', -- 캘린더 색상
    -- 신청 폼 커스터마이즈 (JSON)
    form_fields  TEXT    NOT NULL DEFAULT '["name","phone","organization","referrer"]',
    form_labels  TEXT    NOT NULL DEFAULT '{}',      -- {"name":"이름",...}
    form_required TEXT   NOT NULL DEFAULT '["name","phone","organization"]',
    form_placeholders TEXT NOT NULL DEFAULT '{}',    -- {"name":"홍길동","phone":"010-1234-5678",...}
    -- 포스터
    poster_image  TEXT   NOT NULL DEFAULT '',        -- 이벤트 포스터 이미지 URL (단일, 레거시)
    poster_texts  TEXT   NOT NULL DEFAULT '[]',      -- 텍스트 오버레이 JSON 배열
    poster_images TEXT   NOT NULL DEFAULT '[]',      -- 다중 포스터 이미지 URL 배열 (JSON)
    -- 안내 문구
    hero_badge   TEXT    NOT NULL DEFAULT '선착순 무료 신청',
    hero_title   TEXT    NOT NULL DEFAULT '',        -- 비면 title 사용
    hero_subtitle TEXT   NOT NULL DEFAULT '',
    notice_text  TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  )`);

  // ── 출석 세션 (오전/오후/1일차/2일차 등) ──────────────────────────────────
  d.exec(`CREATE TABLE IF NOT EXISTS attendance_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,   -- '오전 교육', '오후 실습', '1일차' 등
    session_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  )`);

  // ── 신청자 ───────────────────────────────────────────────────────────────
  d.exec(`CREATE TABLE IF NOT EXISTS registrations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    ticket_number INTEGER NOT NULL,
    name          TEXT    NOT NULL,
    phone         TEXT    NOT NULL,
    organization  TEXT    NOT NULL DEFAULT '',
    referrer      TEXT    NOT NULL DEFAULT '',
    extra_data    TEXT    NOT NULL DEFAULT '{}',   -- 추가 커스텀 필드 JSON
    ticket_code   TEXT    UNIQUE NOT NULL,
    registered_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(event_id, ticket_number),
    UNIQUE(event_id, phone)
  )`);

  // ── 출석 기록 (세션별) ────────────────────────────────────────────────────
  d.exec(`CREATE TABLE IF NOT EXISTS attendance_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    session_id     INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    attended_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(registration_id, session_id)
  )`);

  // ── 기존 DB 마이그레이션: 구형 registrations 테이블 처리 ──────────────────
  try {
    const cols = d.prepare("PRAGMA table_info(registrations)").all().map(r => r.name);
    if (cols.includes('attended') && !cols.includes('event_id')) {
      // 구형 단일-이벤트 테이블 → 새 구조로 마이그레이션
      const oldRegs = d.prepare("SELECT * FROM registrations").all();
      if (oldRegs.length > 0 && cols.includes('attended')) {
        // 기본 이벤트 생성
        const oldTitle = (() => { try { return d.prepare("SELECT value FROM settings WHERE key='seminar_title'").get()?.value || '라스북 학부모 세미나'; } catch(e){ return '라스북 학부모 세미나'; } })();
        const oldDate  = (() => { try { return d.prepare("SELECT value FROM settings WHERE key='seminar_date'").get()?.value || ''; } catch(e){ return ''; } })();
        const oldVenue = (() => { try { return d.prepare("SELECT value FROM settings WHERE key='seminar_venue'").get()?.value || ''; } catch(e){ return ''; } })();
        const oldCap   = (() => { try { return parseInt(d.prepare("SELECT value FROM settings WHERE key='max_capacity'").get()?.value) || 120; } catch(e){ return 120; } })();

        // 날짜 파싱
        let evDate = new Date().toISOString().slice(0,10);
        const dm = oldDate.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
        if (dm) evDate = `${dm[1]}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}`;

        d.exec("DROP TABLE IF EXISTS registrations");
        d.exec(`CREATE TABLE IF NOT EXISTS registrations (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          ticket_number INTEGER NOT NULL,
          name          TEXT    NOT NULL,
          phone         TEXT    NOT NULL,
          organization  TEXT    NOT NULL DEFAULT '',
          referrer      TEXT    NOT NULL DEFAULT '',
          extra_data    TEXT    NOT NULL DEFAULT '{}',
          ticket_code   TEXT    UNIQUE NOT NULL,
          registered_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
          UNIQUE(event_id, ticket_number),
          UNIQUE(event_id, phone)
        )`);

        const evId = d.prepare(`INSERT INTO events(title,category,event_date,venue,max_capacity) VALUES(?,?,?,?,?)`).run(oldTitle,'세미나',evDate,oldVenue,oldCap).lastInsertRowid;
        const sesId = d.prepare(`INSERT INTO attendance_sessions(event_id,name,session_order) VALUES(?,?,?)`).run(evId,'출석 체크',0).lastInsertRowid;

        const insReg = d.prepare(`INSERT OR IGNORE INTO registrations(event_id,ticket_number,name,phone,organization,referrer,ticket_code,registered_at) VALUES(?,?,?,?,?,?,?,?)`);
        const insAtt = d.prepare(`INSERT OR IGNORE INTO attendance_records(registration_id,session_id,attended_at) VALUES(?,?,?)`);

        for (const r of oldRegs) {
          const res = insReg.run(evId, r.ticket_number, r.name, r.phone, r.organization||'', r.referrer||'', r.ticket_code, r.registered_at);
          if (r.attended === 1) {
            insAtt.run(res.lastInsertRowid || d.prepare("SELECT id FROM registrations WHERE ticket_code=?").get(r.ticket_code)?.id, sesId, r.attended_at || datetime('now','localtime'));
          }
        }
      }
    }
  } catch(e) { /* migration not needed */ }

  // ── 컬럼 마이그레이션 (기존 테이블에 새 컬럼 추가) ──────────────────────
  try {
    const evCols = d.prepare("PRAGMA table_info(events)").all().map(r=>r.name);
    if (!evCols.includes('form_placeholders')) {
      d.exec("ALTER TABLE events ADD COLUMN form_placeholders TEXT NOT NULL DEFAULT '{}'");
    }
    if (!evCols.includes('poster_image')) {
      d.exec("ALTER TABLE events ADD COLUMN poster_image TEXT NOT NULL DEFAULT ''");
    }
    if (!evCols.includes('poster_texts')) {
      d.exec("ALTER TABLE events ADD COLUMN poster_texts TEXT NOT NULL DEFAULT '[]'");
    }
    if (!evCols.includes('event_time')) {
      d.exec("ALTER TABLE events ADD COLUMN event_time TEXT NOT NULL DEFAULT ''");
    }
    if (!evCols.includes('poster_images')) {
      d.exec("ALTER TABLE events ADD COLUMN poster_images TEXT NOT NULL DEFAULT '[]'");
    }
    // 대기 인원 컬럼
    if (!evCols.includes('waitlist_capacity')) {
      d.exec("ALTER TABLE events ADD COLUMN waitlist_capacity INTEGER NOT NULL DEFAULT 0");
    }
  } catch(e) { /* column migration optional */ }

  // ── categories 테이블 생성 + 기본값 삽입 ─────────────────────────────────
  try {
    d.exec(`CREATE TABLE IF NOT EXISTS categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
    // 기존 카테고리 기본값 삽입 (없으면)
    const ins = d.prepare('INSERT OR IGNORE INTO categories(name,sort_order) VALUES(?,?)');
    [['세미나',0],['직무연수',1],['교육',2],['기타',3]].forEach(([n,o]) => ins.run(n,o));
    // 기존 이벤트에서 쓰고 있는 카테고리 값도 자동 추가
    const evCats = d.prepare('SELECT DISTINCT category FROM events WHERE category IS NOT NULL AND category != \'\'').all();
    evCats.forEach(r => ins.run(r.category, 99));
  } catch(e) { /* categories optional */ }
  try {
    const regCols = d.prepare("PRAGMA table_info(registrations)").all().map(r=>r.name);
    if (!regCols.includes('status')) {
      // 기존 데이터는 모두 'confirmed'
      d.exec("ALTER TABLE registrations ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'");
    }
    if (!regCols.includes('waitlist_number')) {
      d.exec("ALTER TABLE registrations ADD COLUMN waitlist_number INTEGER DEFAULT NULL");
    }
  } catch(e) { /* column migration optional */ }

  // ── 인덱스 생성 (마이그레이션 후) ────────────────────────────────────────
  try {
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_reg_ticket   ON registrations(ticket_code);
      CREATE INDEX IF NOT EXISTS idx_reg_event    ON registrations(event_id);
      CREATE INDEX IF NOT EXISTS idx_att_reg      ON attendance_records(registration_id);
      CREATE INDEX IF NOT EXISTS idx_att_session  ON attendance_records(session_id);
    `);
  } catch(e) { /* indexes optional */ }

  // ── 기본 샘플 이벤트 (DB가 완전히 비어있을 때만) ──────────────────────────
  const evCount = d.prepare("SELECT COUNT(*) as c FROM events").get().c;
  if (evCount === 0) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const dd = String(today.getDate()).padStart(2,'0');
    const evId = d.prepare(`
      INSERT INTO events(title,category,event_date,venue,max_capacity,hero_subtitle)
      VALUES(?,?,?,?,?,?)
    `).run('라스북 학부모 세미나','세미나',`${yyyy}-${mm}-${dd}`,'라스북 교육문화센터 대강당',120,'아이의 미래를 위한 교육 인사이트\n학부모님을 초대합니다').lastInsertRowid;
    d.prepare(`INSERT INTO attendance_sessions(event_id,name,session_order) VALUES(?,?,?)`).run(evId,'출석 체크',0);
  }
}

module.exports = { getDb };
