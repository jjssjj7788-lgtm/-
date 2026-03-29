const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');

// ─── GET: 세미나 정보 및 현황 ────────────────────────────────────────────────
router.get('/status', (req, res) => {
  try {
    const db = getDb();
    const maxCapacity = parseInt(db.prepare("SELECT value FROM settings WHERE key='max_capacity'").get().value);
    const currentCount = db.prepare("SELECT COUNT(*) as cnt FROM registrations").get().cnt;
    const attendedCount = db.prepare("SELECT COUNT(*) as cnt FROM registrations WHERE attended=1").get().cnt;
    const title = db.prepare("SELECT value FROM settings WHERE key='seminar_title'").get().value;
    const date = db.prepare("SELECT value FROM settings WHERE key='seminar_date'").get().value;
    const venue = db.prepare("SELECT value FROM settings WHERE key='seminar_venue'").get().value;

    res.json({
      success: true,
      data: {
        maxCapacity,
        currentCount,
        attendedCount,
        remaining: Math.max(0, maxCapacity - currentCount),
        isFull: currentCount >= maxCapacity,
        title,
        date,
        venue
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST: 신청 등록 ────────────────────────────────────────────────────────
router.post('/register', (req, res) => {
  try {
    const db = getDb();
    const { name, phone, organization, referrer } = req.body;

    // 필수 필드 검증
    if (!name || !phone || !organization) {
      return res.status(400).json({ success: false, message: '이름, 연락처, 소속은 필수 입력 항목입니다.' });
    }

    // 이름 검증
    if (name.trim().length < 2) {
      return res.status(400).json({ success: false, message: '이름을 올바르게 입력해주세요.' });
    }

    // 연락처 검증 (숫자만, 10-11자리)
    const phoneClean = phone.replace(/[^0-9]/g, '');
    if (phoneClean.length < 10 || phoneClean.length > 11) {
      return res.status(400).json({ success: false, message: '올바른 연락처를 입력해주세요. (예: 010-1234-5678)' });
    }

    // 트랜잭션으로 정원 체크 + 등록 처리
    const register = db.transaction(() => {
      const maxCapacity = parseInt(db.prepare("SELECT value FROM settings WHERE key='max_capacity'").get().value);
      const currentCount = db.prepare("SELECT COUNT(*) as cnt FROM registrations").get().cnt;

      if (currentCount >= maxCapacity) {
        return { success: false, message: '정원이 마감되었습니다. 많은 관심에 감사드립니다.' };
      }

      // 중복 신청 체크 (동일 연락처)
      const existing = db.prepare("SELECT id, name FROM registrations WHERE phone=?").get(phoneClean);
      if (existing) {
        return { success: false, message: `이미 신청이 완료된 연락처입니다. (신청자: ${existing.name})`, duplicate: true };
      }

      // 티켓 번호 및 고유 코드 생성
      const ticketNumber = currentCount + 1;
      const ticketCode = 'LASBOOK-' + uuidv4().replace(/-/g, '').substring(0, 12).toUpperCase();

      // 등록
      const stmt = db.prepare(`
        INSERT INTO registrations (ticket_number, name, phone, organization, referrer, ticket_code, registered_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      `);
      stmt.run(ticketNumber, name.trim(), phoneClean, organization.trim(), referrer ? referrer.trim() : '', ticketCode);

      return {
        success: true,
        data: {
          ticketNumber,
          ticketCode,
          name: name.trim(),
          organization: organization.trim()
        }
      };
    });

    const result = register();
    if (!result.success) {
      return res.status(result.duplicate ? 409 : 400).json(result);
    }
    res.json(result);

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

// ─── GET: 티켓 정보 조회 ────────────────────────────────────────────────────
router.get('/ticket/:code', (req, res) => {
  try {
    const db = getDb();
    const { code } = req.params;
    const ticket = db.prepare("SELECT * FROM registrations WHERE ticket_code=?").get(code);

    if (!ticket) {
      return res.status(404).json({ success: false, message: '티켓을 찾을 수 없습니다.' });
    }

    const title = db.prepare("SELECT value FROM settings WHERE key='seminar_title'").get().value;
    const date = db.prepare("SELECT value FROM settings WHERE key='seminar_date'").get().value;
    const venue = db.prepare("SELECT value FROM settings WHERE key='seminar_venue'").get().value;

    res.json({
      success: true,
      data: {
        ticketNumber: ticket.ticket_number,
        ticketCode: ticket.ticket_code,
        name: ticket.name,
        organization: ticket.organization,
        registeredAt: ticket.registered_at,
        attended: ticket.attended === 1,
        attendedAt: ticket.attended_at,
        seminarTitle: title,
        seminarDate: date,
        seminarVenue: venue
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: 인증 미들웨어 ────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const db = getDb();
  const adminPassword = db.prepare("SELECT value FROM settings WHERE key='admin_password'").get().value;
  const authHeader = req.headers['x-admin-token'];
  if (!authHeader || authHeader !== adminPassword) {
    return res.status(401).json({ success: false, message: '관리자 인증이 필요합니다.' });
  }
  next();
}

// ─── ADMIN: 로그인 ────────────────────────────────────────────────────────────
router.post('/admin/login', (req, res) => {
  try {
    const db = getDb();
    const { password } = req.body;
    const adminPassword = db.prepare("SELECT value FROM settings WHERE key='admin_password'").get().value;

    if (password === adminPassword) {
      res.json({ success: true, token: adminPassword });
    } else {
      res.status(401).json({ success: false, message: '비밀번호가 올바르지 않습니다.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: 설정 조회 ─────────────────────────────────────────────────────────
router.get('/admin/settings', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const settings = {};
    const rows = db.prepare("SELECT key, value FROM settings").all();
    rows.forEach(row => { settings[row.key] = row.value; });
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: 설정 업데이트 ─────────────────────────────────────────────────────
router.put('/admin/settings', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const allowed = ['max_capacity', 'seminar_title', 'seminar_date', 'seminar_venue'];
    const updateSetting = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");

    const updates = db.transaction(() => {
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          if (key === 'max_capacity') {
            const val = parseInt(req.body[key]);
            if (isNaN(val) || val < 1 || val > 9999) {
              throw new Error('정원은 1~9999 사이의 숫자여야 합니다.');
            }
            // 현재 신청 인원보다 낮게 설정 방지
            const currentCount = db.prepare("SELECT COUNT(*) as cnt FROM registrations").get().cnt;
            if (val < currentCount) {
              throw new Error(`현재 신청 인원(${currentCount}명)보다 낮게 설정할 수 없습니다.`);
            }
            updateSetting.run(key, String(val));
          } else {
            updateSetting.run(key, String(req.body[key]));
          }
        }
      }
    });

    updates();
    res.json({ success: true, message: '설정이 저장되었습니다.' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: 신청자 목록 ────────────────────────────────────────────────────────
router.get('/admin/registrations', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const registrations = db.prepare(`
      SELECT ticket_number, name, phone, organization, referrer, registered_at, attended, attended_at
      FROM registrations
      ORDER BY ticket_number ASC
    `).all();

    res.json({ success: true, data: registrations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: CSV 다운로드 ──────────────────────────────────────────────────────
router.get('/admin/export-csv', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const registrations = db.prepare(`
      SELECT ticket_number, name, phone, organization, referrer, registered_at, attended, attended_at
      FROM registrations
      ORDER BY ticket_number ASC
    `).all();

    const BOM = '\uFEFF';
    let csv = BOM + '번호,이름,연락처,소속,추천인,신청일시,출석여부,출석시간\n';
    registrations.forEach(r => {
      csv += `${r.ticket_number},"${r.name}","${r.phone}","${r.organization}","${r.referrer || ''}","${r.registered_at}","${r.attended ? '출석' : '미출석'}","${r.attended_at || ''}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="lasbook_seminar_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: 출석 체크 (바코드 스캔) ──────────────────────────────────────────
router.post('/admin/attendance', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const { ticketCode } = req.body;

    if (!ticketCode) {
      return res.status(400).json({ success: false, message: '티켓 코드가 없습니다.' });
    }

    const ticket = db.prepare("SELECT * FROM registrations WHERE ticket_code=?").get(ticketCode);

    if (!ticket) {
      return res.status(404).json({ success: false, message: '등록되지 않은 티켓입니다.', status: 'not_found' });
    }

    if (ticket.attended === 1) {
      return res.status(409).json({
        success: false,
        message: `이미 출석 처리된 티켓입니다.\n입장 시간: ${ticket.attended_at}`,
        status: 'duplicate',
        data: {
          ticketNumber: ticket.ticket_number,
          name: ticket.name,
          organization: ticket.organization,
          attendedAt: ticket.attended_at
        }
      });
    }

    // 출석 처리
    db.prepare(`
      UPDATE registrations SET attended=1, attended_at=datetime('now', 'localtime') WHERE ticket_code=?
    `).run(ticketCode);

    const updatedTicket = db.prepare("SELECT * FROM registrations WHERE ticket_code=?").get(ticketCode);

    res.json({
      success: true,
      message: '출석 처리 완료!',
      status: 'success',
      data: {
        ticketNumber: updatedTicket.ticket_number,
        name: updatedTicket.name,
        organization: updatedTicket.organization,
        attendedAt: updatedTicket.attended_at
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: 출석 수동 토글 ────────────────────────────────────────────────────
router.put('/admin/attendance/:ticketNumber', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const { ticketNumber } = req.params;
    const { attended } = req.body;

    const ticket = db.prepare("SELECT * FROM registrations WHERE ticket_number=?").get(parseInt(ticketNumber));
    if (!ticket) {
      return res.status(404).json({ success: false, message: '티켓을 찾을 수 없습니다.' });
    }

    if (attended) {
      db.prepare(`UPDATE registrations SET attended=1, attended_at=datetime('now', 'localtime') WHERE ticket_number=?`).run(parseInt(ticketNumber));
    } else {
      db.prepare(`UPDATE registrations SET attended=0, attended_at=NULL WHERE ticket_number=?`).run(parseInt(ticketNumber));
    }

    res.json({ success: true, message: '출석 상태가 변경되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: 신청자 삭제 ────────────────────────────────────────────────────────
router.delete('/admin/registrations/:ticketNumber', adminAuth, (req, res) => {
  try {
    const db = getDb();
    const { ticketNumber } = req.params;
    db.prepare("DELETE FROM registrations WHERE ticket_number=?").run(parseInt(ticketNumber));
    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
