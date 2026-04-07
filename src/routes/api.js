const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');

// ─── 관리자 인증 미들웨어 ────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const db = getDb();
  const pw = db.prepare("SELECT value FROM settings WHERE key='admin_password'").get()?.value;
  // Support both header and query param (for window.open CSV download)
  const tok = req.headers['x-admin-token'] || req.query.token;
  if (!tok || tok !== pw)
    return res.status(401).json({ success: false, message: '관리자 인증이 필요합니다.' });
  next();
}

// ─── 공통 헬퍼 ────────────────────────────────────────────────────────────────
function getEventStatus(db, eventId) {
  const ev    = db.prepare("SELECT * FROM events WHERE id=?").get(eventId);
  if (!ev) return null;
  const total = db.prepare("SELECT COUNT(*) as c FROM registrations WHERE event_id=?").get(eventId).c;
  const sessions = db.prepare("SELECT * FROM attendance_sessions WHERE event_id=? ORDER BY session_order").all(eventId);
  const sessionsWithCount = sessions.map(s => {
    const cnt = db.prepare("SELECT COUNT(*) as c FROM attendance_records WHERE session_id=?").get(s.id).c;
    return { ...s, attended_count: cnt };
  });
  return { ...ev, current_count: total, sessions: sessionsWithCount };
}

// ════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ════════════════════════════════════════════════════════════════════════

// ── 이벤트 목록 (공개용 - 활성화된 것만) ────────────────────────────────────
router.get('/events', (req, res) => {
  try {
    const db = getDb();
    const events = db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM registrations r WHERE r.event_id=e.id) as current_count
      FROM events e
      WHERE e.is_active=1
      ORDER BY e.event_date ASC, e.id ASC
    `).all();
    res.json({ success: true, data: events });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── 이벤트 상세 (공개) ───────────────────────────────────────────────────────
router.get('/events/:id', (req, res) => {
  try {
    const db = getDb();
    const ev = getEventStatus(db, parseInt(req.params.id));
    if (!ev) return res.status(404).json({ success:false, message:'이벤트를 찾을 수 없습니다.' });
    res.json({ success:true, data: ev });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── 신청 등록 ────────────────────────────────────────────────────────────────
router.post('/events/:id/register', (req, res) => {
  try {
    const db = getDb();
    const eventId = parseInt(req.params.id);
    const ev = db.prepare("SELECT * FROM events WHERE id=? AND is_active=1").get(eventId);
    if (!ev) return res.status(404).json({ success:false, message:'이벤트를 찾을 수 없습니다.' });

    const { name, phone, organization, referrer, extra_data } = req.body;
    if (!name?.trim()) return res.status(400).json({ success:false, message:'이름을 입력해주세요.' });

    // 필수 필드 검증
    const required = JSON.parse(ev.form_required || '["name","phone","organization"]');
    const fields   = JSON.parse(ev.form_fields   || '["name","phone","organization","referrer"]');
    for (const f of required) {
      if (f === 'name' && !name?.trim())         return res.status(400).json({ success:false, message:'이름을 입력해주세요.' });
      if (f === 'phone' && !phone?.trim())        return res.status(400).json({ success:false, message:'연락처를 입력해주세요.' });
      if (f === 'organization' && !organization?.trim()) return res.status(400).json({ success:false, message:'소속을 입력해주세요.' });
    }

    const phoneClean = (phone||'').replace(/[^0-9]/g,'');
    if (required.includes('phone') && (phoneClean.length < 10 || phoneClean.length > 11))
      return res.status(400).json({ success:false, message:'올바른 연락처를 입력해주세요.' });

    const register = db.transaction(() => {
      const total = db.prepare("SELECT COUNT(*) as c FROM registrations WHERE event_id=?").get(eventId).c;
      if (total >= ev.max_capacity)
        return { success:false, message:'정원이 마감되었습니다.' };

      // 중복 체크
      if (phoneClean) {
        const dup = db.prepare("SELECT name FROM registrations WHERE event_id=? AND phone=?").get(eventId, phoneClean);
        if (dup) return { success:false, message:`이미 신청하셨습니다. (신청자: ${dup.name})`, duplicate:true };
      }

      // MAX 기반으로 ticket_number 계산 (COUNT 기반 시 삭제/충돌 문제 방지)
      const maxRow = db.prepare("SELECT MAX(ticket_number) as m FROM registrations WHERE event_id=?").get(eventId);
      const ticketNumber = (maxRow.m || 0) + 1;
      const ticketCode   = 'LB-' + uuidv4().replace(/-/g,'').substring(0,14).toUpperCase();
      const extraJson    = JSON.stringify(extra_data || {});

      // KST(UTC+9) 시간 직접 생성
      const nowKST = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const kstStr = nowKST.toISOString().replace('T',' ').slice(0,19);

      db.prepare(`
        INSERT INTO registrations(event_id,ticket_number,name,phone,organization,referrer,extra_data,ticket_code,registered_at)
        VALUES(?,?,?,?,?,?,?,?,?)
      `).run(eventId, ticketNumber, name.trim(), phoneClean, (organization||'').trim(), (referrer||'').trim(), extraJson, ticketCode, kstStr);

      return { success:true, data:{ ticketNumber, ticketCode, name:name.trim(), eventTitle:ev.title } };
    });

    // UNIQUE 충돌 시 최대 3회 재시도
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = register();
        break;
      } catch(retryErr) {
        if (retryErr.code === 'SQLITE_CONSTRAINT_UNIQUE' && attempt < 2) {
          // 동기 재시도: 잠깐 대기 없이 바로 재시도 (MAX 재계산으로 충돌 해소)
          continue;
        }
        throw retryErr;
      }
    }
    res.status(result.success ? 200 : result.duplicate ? 409 : 400).json(result);
  } catch(e) {
    console.error(e);
    res.status(500).json({ success:false, message:'서버 오류가 발생했습니다.' });
  }
});

// ── 공개 이벤트 목록 (날짜별 달력용) ─────────────────────────────────────────
router.get('/public/events', (req, res) => {
  try {
    const db = getDb();
    const events = db.prepare(`
      SELECT id, title, event_date, venue, category, color, max_capacity,
        (SELECT COUNT(*) FROM registrations r WHERE r.event_id=e.id) as current_count
      FROM events e
      WHERE e.is_active=1
      ORDER BY e.event_date ASC, e.id ASC
    `).all();
    res.json({ success:true, data: events });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── 추천인 현황 공개 조회 ─────────────────────────────────────────────────────
router.get('/public/referrer-stats/:eventId', (req, res) => {
  try {
    const db = getDb();
    const eventId = parseInt(req.params.eventId);
    const ev = db.prepare("SELECT id, title, event_date, venue, max_capacity FROM events WHERE id=? AND is_active=1").get(eventId);
    if (!ev) return res.status(404).json({ success:false, message:'이벤트를 찾을 수 없습니다.' });

    // 전체 신청자 수
    const totalRow = db.prepare("SELECT COUNT(*) as c FROM registrations WHERE event_id=?").get(eventId);

    // 추천인별 신청자 목록 (이름만 공개, 연락처 비공개)
    const referrers = db.prepare(`
      SELECT referrer, COUNT(*) as cnt
      FROM registrations
      WHERE event_id=? AND referrer IS NOT NULL AND referrer != ''
      GROUP BY referrer
      ORDER BY cnt DESC, referrer ASC
    `).all(eventId);

    // 추천인별 신청자 이름 목록
    const referrerDetails = referrers.map(r => {
      const members = db.prepare(`
        SELECT name, organization, registered_at
        FROM registrations
        WHERE event_id=? AND referrer=?
        ORDER BY registered_at ASC
      `).all(eventId, r.referrer);
      return { referrer: r.referrer, count: r.cnt, members };
    });

    // 추천인 없는(직접 신청) 신청자 수
    const noRefRow = db.prepare(`
      SELECT COUNT(*) as c FROM registrations
      WHERE event_id=? AND (referrer IS NULL OR referrer='')
    `).get(eventId);

    res.json({
      success: true,
      data: {
        event: ev,
        totalCount: totalRow.c,
        noReferrerCount: noRefRow.c,
        referrers: referrerDetails
      }
    });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── 티켓 조회 ────────────────────────────────────────────────────────────────
router.get('/ticket/:code', (req, res) => {
  try {
    const db = getDb();
    const reg = db.prepare("SELECT * FROM registrations WHERE ticket_code=?").get(req.params.code);
    if (!reg) return res.status(404).json({ success:false, message:'티켓을 찾을 수 없습니다.' });

    const ev = db.prepare("SELECT * FROM events WHERE id=?").get(reg.event_id);
    const sessions = db.prepare(`
      SELECT s.*, ar.attended_at
      FROM attendance_sessions s
      LEFT JOIN attendance_records ar ON ar.session_id=s.id AND ar.registration_id=?
      WHERE s.event_id=?
      ORDER BY s.session_order
    `).all(reg.id, reg.event_id);

    res.json({ success:true, data:{
      ticketNumber: reg.ticket_number,
      ticketCode:   reg.ticket_code,
      name:         reg.name,
      phone:        reg.phone,
      organization: reg.organization,
      referrer:     reg.referrer,
      extraData:    JSON.parse(reg.extra_data||'{}'),
      registeredAt: reg.registered_at,
      event: {
        id: ev.id, title: ev.title, category: ev.category,
        eventDate: ev.event_date, venue: ev.venue,
        eventTime: ev.event_time || '',
        heroTitle: ev.hero_title || ev.title,
        heroSubtitle: ev.hero_subtitle
      },
      sessions: sessions.map(s => ({
        id: s.id, name: s.name,
        attended: !!s.attended_at,
        attendedAt: s.attended_at || null
      }))
    }});
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════════════════════════════════════════════

// ── 로그인 ───────────────────────────────────────────────────────────────────
router.post('/admin/login', (req, res) => {
  const db = getDb();
  const pw = db.prepare("SELECT value FROM settings WHERE key='admin_password'").get()?.value;
  if (req.body.password === pw) res.json({ success:true, token:pw });
  else res.status(401).json({ success:false, message:'비밀번호가 올바르지 않습니다.' });
});

// ── 전역 설정 ────────────────────────────────────────────────────────────────
router.get('/admin/settings', adminAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT key,value FROM settings").all();
  const s = {}; rows.forEach(r => s[r.key]=r.value);
  res.json({ success:true, data:s });
});
router.put('/admin/settings', adminAuth, (req, res) => {
  const db = getDb();
  const allowed = ['org_name'];
  const upd = db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)");
  const tx = db.transaction(() => { for (const k of allowed) if (req.body[k]!==undefined) upd.run(k,String(req.body[k])); });
  tx(); res.json({ success:true });
});

// ── 이벤트 CRUD ──────────────────────────────────────────────────────────────
router.get('/admin/events', adminAuth, (req, res) => {
  const db = getDb();
  const events = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id=e.id) as current_count,
      (SELECT COUNT(*) FROM attendance_sessions s WHERE s.event_id=e.id) as session_count
    FROM events e ORDER BY e.event_date DESC, e.id DESC
  `).all();
  res.json({ success:true, data:events });
});

router.get('/admin/events/:id', adminAuth, (req, res) => {
  const db = getDb();
  const ev = getEventStatus(db, parseInt(req.params.id));
  if (!ev) return res.status(404).json({ success:false, message:'이벤트 없음' });
  res.json({ success:true, data:ev });
});

router.post('/admin/events', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const { title, category, event_date, venue, event_time, description, max_capacity, color,
            form_fields, form_labels, form_required, form_placeholders,
            poster_image, poster_texts,
            hero_badge, hero_title, hero_subtitle, notice_text } = req.body;
    if (!title?.trim()) return res.status(400).json({ success:false, message:'제목을 입력해주세요.' });
    if (!event_date)    return res.status(400).json({ success:false, message:'날짜를 입력해주세요.' });

    const id = db.prepare(`
      INSERT INTO events(title,category,event_date,venue,event_time,description,max_capacity,color,
        form_fields,form_labels,form_required,form_placeholders,
        poster_image,poster_texts,
        hero_badge,hero_title,hero_subtitle,notice_text)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      title.trim(), category||'세미나', event_date, venue||'', event_time||'', description||'',
      parseInt(max_capacity)||120, color||'#1B2B4B',
      JSON.stringify(form_fields||["name","phone","organization","referrer"]),
      JSON.stringify(form_labels||{}),
      JSON.stringify(form_required||["name","phone","organization"]),
      JSON.stringify(form_placeholders||{}),
      poster_image||'', JSON.stringify(poster_texts||[]),
      hero_badge||'선착순 무료 신청', hero_title||'', hero_subtitle||'', notice_text||''
    ).lastInsertRowid;

    // 기본 출석 세션 자동 생성
    db.prepare("INSERT INTO attendance_sessions(event_id,name,session_order) VALUES(?,?,?)").run(id,'출석 체크',0);

    res.json({ success:true, data:{ id } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.put('/admin/events/:id', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    const { title, category, event_date, venue, event_time, description, max_capacity, color, is_active,
            form_fields, form_labels, form_required, form_placeholders,
            poster_image, poster_texts,
            hero_badge, hero_title, hero_subtitle, notice_text } = req.body;

    // 정원 축소 방지
    if (max_capacity !== undefined) {
      const cnt = db.prepare("SELECT COUNT(*) as c FROM registrations WHERE event_id=?").get(id).c;
      if (parseInt(max_capacity) < cnt)
        return res.status(400).json({ success:false, message:`현재 신청 인원(${cnt}명)보다 낮게 설정할 수 없습니다.` });
    }

    db.prepare(`UPDATE events SET
      title=COALESCE(?,title), category=COALESCE(?,category),
      event_date=COALESCE(?,event_date), venue=COALESCE(?,venue),
      event_time=COALESCE(?,event_time),
      description=COALESCE(?,description), max_capacity=COALESCE(?,max_capacity),
      color=COALESCE(?,color), is_active=COALESCE(?,is_active),
      form_fields=COALESCE(?,form_fields), form_labels=COALESCE(?,form_labels),
      form_required=COALESCE(?,form_required), form_placeholders=COALESCE(?,form_placeholders),
      poster_image=COALESCE(?,poster_image), poster_texts=COALESCE(?,poster_texts),
      hero_badge=COALESCE(?,hero_badge), hero_title=COALESCE(?,hero_title),
      hero_subtitle=COALESCE(?,hero_subtitle), notice_text=COALESCE(?,notice_text)
      WHERE id=?
    `).run(
      title||null, category||null, event_date||null, venue??null,
      event_time!==undefined?event_time:null,
      description??null,
      max_capacity!==undefined?parseInt(max_capacity):null,
      color||null, is_active!==undefined?(is_active?1:0):null,
      form_fields?JSON.stringify(form_fields):null,
      form_labels?JSON.stringify(form_labels):null,
      form_required?JSON.stringify(form_required):null,
      form_placeholders?JSON.stringify(form_placeholders):null,
      poster_image!==undefined?poster_image:null,
      poster_texts?JSON.stringify(poster_texts):null,
      hero_badge??null, hero_title??null, hero_subtitle??null, notice_text??null,
      id
    );
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/admin/events/:id', adminAuth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM events WHERE id=?").run(parseInt(req.params.id));
  res.json({ success:true });
});

// ── 출석 세션 CRUD ────────────────────────────────────────────────────────────
router.get('/admin/events/:id/sessions', adminAuth, (req, res) => {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM attendance_records ar WHERE ar.session_id=s.id) as attended_count
    FROM attendance_sessions s WHERE s.event_id=? ORDER BY s.session_order
  `).all(parseInt(req.params.id));
  res.json({ success:true, data:sessions });
});

router.post('/admin/events/:id/sessions', adminAuth, (req, res) => {
  const db = getDb();
  const { name, session_order } = req.body;
  if (!name?.trim()) return res.status(400).json({ success:false, message:'세션 이름을 입력해주세요.' });
  const maxOrder = db.prepare("SELECT MAX(session_order) as m FROM attendance_sessions WHERE event_id=?").get(parseInt(req.params.id))?.m ?? -1;
  const id = db.prepare("INSERT INTO attendance_sessions(event_id,name,session_order) VALUES(?,?,?)").run(parseInt(req.params.id),name.trim(), session_order??maxOrder+1).lastInsertRowid;
  res.json({ success:true, data:{ id } });
});

router.put('/admin/sessions/:id', adminAuth, (req, res) => {
  const db = getDb();
  const { name, session_order } = req.body;
  db.prepare("UPDATE attendance_sessions SET name=COALESCE(?,name), session_order=COALESCE(?,session_order) WHERE id=?").run(name||null, session_order??null, parseInt(req.params.id));
  res.json({ success:true });
});

router.delete('/admin/sessions/:id', adminAuth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM attendance_sessions WHERE id=?").run(parseInt(req.params.id));
  res.json({ success:true });
});

// ── 신청자 목록 ───────────────────────────────────────────────────────────────
router.get('/admin/events/:id/registrations', adminAuth, (req, res) => {
  const db = getDb();
  const eventId = parseInt(req.params.id);
  const regs = db.prepare("SELECT * FROM registrations WHERE event_id=? ORDER BY ticket_number").all(eventId);
  const sessions = db.prepare("SELECT * FROM attendance_sessions WHERE event_id=? ORDER BY session_order").all(eventId);
  const records  = db.prepare(`
    SELECT ar.registration_id, ar.session_id, ar.attended_at
    FROM attendance_records ar
    JOIN registrations r ON r.id=ar.registration_id
    WHERE r.event_id=?
  `).all(eventId);

  // 신청자마다 세션별 출석 여부 합산
  const recMap = {};
  for (const r of records) {
    if (!recMap[r.registration_id]) recMap[r.registration_id] = {};
    recMap[r.registration_id][r.session_id] = r.attended_at;
  }

  const data = regs.map(r => ({
    ...r,
    extra_data: JSON.parse(r.extra_data||'{}'),
    attendance: sessions.map(s => ({
      session_id: s.id, session_name: s.name,
      attended: !!recMap[r.id]?.[s.id],
      attended_at: recMap[r.id]?.[s.id] || null
    }))
  }));

  res.json({ success:true, data, sessions });
});

// ── CSV 내보내기 ──────────────────────────────────────────────────────────────
router.get('/admin/events/:id/export-csv', adminAuth, (req, res) => {
  const db = getDb();
  const eventId = parseInt(req.params.id);
  const ev = db.prepare("SELECT * FROM events WHERE id=?").get(eventId);
  const sessions = db.prepare("SELECT * FROM attendance_sessions WHERE event_id=? ORDER BY session_order").all(eventId);
  const regs = db.prepare("SELECT * FROM registrations WHERE event_id=? ORDER BY ticket_number").all(eventId);
  const records = db.prepare(`
    SELECT ar.registration_id, ar.session_id, ar.attended_at
    FROM attendance_records ar JOIN registrations r ON r.id=ar.registration_id WHERE r.event_id=?
  `).all(eventId);
  const recMap = {};
  for (const r of records) { if (!recMap[r.registration_id]) recMap[r.registration_id]={}; recMap[r.registration_id][r.session_id]=r.attended_at; }

  const BOM = '\uFEFF';
  const sesHeaders = sessions.map(s => `"${s.name}"`).join(',');
  let csv = BOM + `번호,이름,연락처,소속,추천인,신청일시,${sesHeaders}\n`;
  for (const r of regs) {
    const attCols = sessions.map(s => recMap[r.id]?.[s.id] ? `"출석(${recMap[r.id][s.id]})"` : '"미출석"').join(',');
    csv += `${r.ticket_number},"${r.name}","${r.phone}","${r.organization}","${r.referrer||''}","${r.registered_at}",${attCols}\n`;
  }
  const dateStr = new Date().toISOString().slice(0,10);
  const safeTitle = (ev?.title||'event').replace(/[^\w\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g,'_');
  const encodedFilename = encodeURIComponent(`lasbook_${safeTitle}_${dateStr}.csv`);
  res.setHeader('Content-Type','text/csv;charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodedFilename}`);
  res.send(csv);
});

// ── 출석 처리 (스캔) ──────────────────────────────────────────────────────────
router.post('/admin/attendance', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const { ticketCode, sessionId } = req.body;
    if (!ticketCode) return res.status(400).json({ success:false, message:'티켓 코드가 없습니다.' });
    if (!sessionId)  return res.status(400).json({ success:false, message:'세션을 선택해주세요.' });

    const reg = db.prepare("SELECT * FROM registrations WHERE ticket_code=?").get(ticketCode);
    if (!reg) return res.status(404).json({ success:false, message:'등록되지 않은 티켓입니다.', status:'not_found' });

    const session = db.prepare("SELECT * FROM attendance_sessions WHERE id=?").get(parseInt(sessionId));
    if (!session) return res.status(404).json({ success:false, message:'세션을 찾을 수 없습니다.' });
    if (session.event_id !== reg.event_id)
      return res.status(400).json({ success:false, message:'이 티켓은 다른 이벤트 소속입니다.', status:'wrong_event' });

    const existing = db.prepare("SELECT * FROM attendance_records WHERE registration_id=? AND session_id=?").get(reg.id, parseInt(sessionId));
    if (existing) return res.status(409).json({
      success:false, message:`이미 출석 처리되었습니다.\n입장 시간: ${existing.attended_at}`,
      status:'duplicate',
      data:{ ticketNumber:reg.ticket_number, name:reg.name, organization:reg.organization, attendedAt:existing.attended_at }
    });

    const attKST = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T',' ').slice(0,19);
    db.prepare("INSERT INTO attendance_records(registration_id,session_id,attended_at) VALUES(?,?,?)").run(reg.id, parseInt(sessionId), attKST);
    const rec = db.prepare("SELECT * FROM attendance_records WHERE registration_id=? AND session_id=?").get(reg.id, parseInt(sessionId));

    res.json({ success:true, message:'출석 처리 완료!', status:'success',
      data:{ ticketNumber:reg.ticket_number, name:reg.name, organization:reg.organization, attendedAt:rec.attended_at, sessionName:session.name }
    });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── 출석 수동 토글 ────────────────────────────────────────────────────────────
router.put('/admin/attendance', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const { registrationId, sessionId, attended } = req.body;
    if (attended) {
      db.prepare("INSERT OR IGNORE INTO attendance_records(registration_id,session_id) VALUES(?,?)").run(registrationId, sessionId);
    } else {
      db.prepare("DELETE FROM attendance_records WHERE registration_id=? AND session_id=?").run(registrationId, sessionId);
    }
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── 신청자 삭제 ───────────────────────────────────────────────────────────────
router.delete('/admin/registrations/:id', adminAuth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM registrations WHERE id=?").run(parseInt(req.params.id));
  res.json({ success:true });
});

// ── 추천인 수정 (하위 호환 유지) ───────────────────────────────────────────────
router.put('/admin/registrations/:id/referrer', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    const referrer = (req.body.referrer || '').trim();
    const reg = db.prepare("SELECT id FROM registrations WHERE id=?").get(id);
    if (!reg) return res.status(404).json({ success:false, message:'신청 정보를 찾을 수 없습니다.' });
    db.prepare("UPDATE registrations SET referrer=? WHERE id=?").run(referrer, id);
    res.json({ success:true, referrer });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success:false, message:e.message });
  }
});

// ── 신청자 전체 필드 수정 ──────────────────────────────────────────────────────
router.put('/admin/registrations/:id', adminAuth, (req, res) => {
  try {
    const db  = getDb();
    const id  = parseInt(req.params.id);
    const reg = db.prepare("SELECT id FROM registrations WHERE id=?").get(id);
    if (!reg) return res.status(404).json({ success:false, message:'신청 정보를 찾을 수 없습니다.' });

    const allowed = ['name', 'phone', 'organization', 'referrer'];
    const updates = [];
    const values  = [];

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field}=?`);
        values.push((req.body[field] || '').trim());
      }
    }
    if (!updates.length) return res.status(400).json({ success:false, message:'수정할 필드가 없습니다.' });

    values.push(id);
    db.prepare(`UPDATE registrations SET ${updates.join(',')} WHERE id=?`).run(...values);

    const updated = db.prepare("SELECT id,name,phone,organization,referrer FROM registrations WHERE id=?").get(id);
    res.json({ success:true, data: updated });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success:false, message:e.message });
  }
});

module.exports = router;
