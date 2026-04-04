const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Trust Proxy (for correct protocol detection behind reverse proxy) ───────
app.set('trust proxy', true);

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for our app
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting - only for registration endpoint
const registerLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min window
  max: 500, // generous limit
  message: { success: false, message: '너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Static Files ─────────────────────────────────────────────────────────────
// index:false so our '/' route handles OG meta injection instead of serving index.html directly
app.use(express.static(path.join(__dirname, 'src', 'public'), { index: false }));

// Upload directory for poster images
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'src', 'public', 'images'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'poster_bg_' + Date.now() + ext);
  }
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|jpg|png|gif|webp)/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('이미지 파일만 업로드 가능합니다.'));
    }
  }
});

// ─── API Routes ───────────────────────────────────────────────────────────────
const apiRouter = require('./src/routes/api');
app.use('/api', registerLimiter);
app.use('/api', apiRouter);

// ── Admin auth middleware (reusable) ─────────────────────────────────────────
function adminAuth(req, res, next) {
  const { getDb } = require('./src/database');
  const db = getDb();
  const pw  = db.prepare("SELECT value FROM settings WHERE key='admin_password'").get()?.value;
  const tok = req.headers['x-admin-token'] || req.query.token;
  if (!tok || tok !== pw) return res.status(401).json({ success: false, message: '관리자 인증이 필요합니다.' });
  next();
}

// ─── OG 이미지 자동 생성 헬퍼 (이벤트 포스터 → 800x800 정사각형 JPEG) ──────
function generateOgImage(posterPath, eventId) {
  try {
    const { execSync } = require('child_process');
    const outPath = path.join(__dirname, 'src', 'public', 'images', `og_poster_${eventId}.jpg`);
    const srcAbs  = path.join(__dirname, posterPath.startsWith('/') ? posterPath.slice(1) : posterPath);
    // Pillow로 800x800 정사각형 크롭+리사이즈
    const script = `
from PIL import Image, ImageOps
import sys
img = Image.open(${JSON.stringify(String(srcAbs))}).convert('RGB')
w, h = img.size
# 상단 5% 여백 후 정사각형 크롭
if w < h:
    cy = int(h * 0.05)
    img = img.crop((0, cy, w, cy + w))
else:
    cx = (w - h) // 2
    img = img.crop((cx, 0, cx + h, h))
img = img.resize((800, 800), Image.LANCZOS)
img.save(${JSON.stringify(String(outPath))}, 'JPEG', quality=88, optimize=True)
print('ok')
`.trim();
    execSync(`python3 -c "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 10000 });
    return `/images/og_poster_${eventId}.jpg`;
  } catch(e) {
    console.error('OG image gen failed:', e.message);
    return null;
  }
}


app.post('/api/upload-poster', adminAuth, upload.single('poster'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: '파일 업로드에 실패했습니다.' });
  }
  res.json({
    success: true,
    url: '/images/' + req.file.filename,
    filename: req.file.filename
  });
});

// List all uploaded poster images (admin auth required)
app.get('/api/poster-images', adminAuth, (req, res) => {
  const imgDir = path.join(__dirname, 'src', 'public', 'images');
  try {
    const files = fs.readdirSync(imgDir)
      .filter(f => /^poster_bg_\d+\.(jpg|jpeg|png|webp)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(imgDir, f));
        return { filename: f, url: '/images/' + f, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first
    res.json({ success: true, images: files });
  } catch(e) {
    res.json({ success: true, images: [] });
  }
});

// Delete a poster image (admin auth required)
app.delete('/api/poster-images/:filename', adminAuth, (req, res) => {
  const filename = req.params.filename;
  // Safety: only allow poster_bg_ files
  if (!/^poster_bg_\d+\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return res.status(400).json({ success: false, message: '허용되지 않는 파일입니다.' });
  }
  const filePath = path.join(__dirname, 'src', 'public', 'images', filename);
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch(e) {
    res.status(404).json({ success: false, message: '파일을 찾을 수 없습니다.' });
  }
});

// ─── OG Meta Injection Helper ────────────────────────────────────────────────
const fs = require('fs');

function buildOgMeta({ title, description, imageUrl, pageUrl }) {
  const t = (title || '라스북 세미나 신청').replace(/"/g, '&quot;');
  const d = (description || '라스북 세미나에 신청하세요').replace(/"/g, '&quot;');
  const img = imageUrl ? `
  <meta property="og:image" content="${imageUrl}" />
  <meta property="og:image:secure_url" content="${imageUrl}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="800" />
  <meta property="og:image:height" content="800" />
  <meta property="og:image:alt" content="${t}" />
  <meta name="twitter:image" content="${imageUrl}" />` : '';
  const url = pageUrl ? `<meta property="og:url" content="${pageUrl}" />` : '';
  return `
  <!-- Open Graph / KakaoTalk -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="라스북" />
  <meta property="og:title" content="${t}" />
  <meta property="og:description" content="${d}" />
  ${img}
  ${url}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${t}" />
  <meta name="twitter:description" content="${d}" />`;
}

function injectOgMeta(htmlPath, ogMeta) {
  let html = fs.readFileSync(htmlPath, 'utf8');

  if (html.includes('<!-- Open Graph / KakaoTalk -->')) {
    // 줄 단위로 처리: OG/twitter 관련 meta 줄과 주석 줄만 제거 후 새 OG 블록 삽입
    const lines = html.split('\n');
    const result = [];
    let ogInserted = false;

    for (const line of lines) {
      const trimmed = line.trim();
      // OG 주석 줄 → 새 OG 블록으로 교체
      if (trimmed === '<!-- Open Graph / KakaoTalk -->') {
        result.push(ogMeta);
        ogInserted = true;
        continue;
      }
      // OG/twitter meta 태그 줄 → 건너뜀 (이미 ogMeta에 포함됨)
      if (ogInserted && /^<meta[^>]+(property="og:|name="twitter:)[^>]*\/>$/.test(trimmed)) {
        continue;
      }
      result.push(line);
    }
    html = result.join('\n');
  } else {
    // OG 주석이 없으면 </head> 바로 앞에 삽입
    html = html.replace('</head>', ogMeta + '\n</head>');
  }

  return html;
}

// ─── Page Routes ─────────────────────────────────────────────────────────────

// Helper: detect the public-facing origin from env var or request headers
function getOrigin(req) {
  // 1. Explicit env var takes priority (set SITE_URL=https://yourdomain.com in production)
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  // 2. Reverse-proxy forwarded headers
  const fwdHost  = req.headers['x-forwarded-host'];
  const fwdProto = req.headers['x-forwarded-proto'];
  if (fwdHost) {
    const proto = (fwdProto || 'https').split(',')[0].trim();
    const host  = fwdHost.split(',')[0].trim();
    return proto + '://' + host;
  }
  // 3. Host header — if host is NOT localhost/127.0.0.1, assume https (CDN/sandbox proxy)
  const host = req.headers.host || ('localhost:' + PORT);
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = isLocal ? 'http' : 'https';
  return proto + '://' + host;
}

// Main page – dynamically inject OG tags based on ?event=ID
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'src', 'public', 'index.html');
  const eventId = parseInt(req.query.event);
  const origin = getOrigin(req);

  if (eventId) {
    try {
      const { getDb } = require('./src/database');
      const db = getDb();
      const ev = db.prepare("SELECT * FROM events WHERE id=? AND is_active=1").get(eventId);
      if (ev) {
        // OG 이미지: 미리 생성된 800x800 정사각형 우선, 없으면 원본 포스터로 즉시 생성, 없으면 기본
        const ogImgFile = path.join(__dirname, 'src', 'public', 'images', `og_poster_${eventId}.jpg`);
        let posterUrl;
        if (require('fs').existsSync(ogImgFile)) {
          posterUrl = origin + `/images/og_poster_${eventId}.jpg`;
        } else if (ev.poster_image) {
          const ogPath = generateOgImage(ev.poster_image, eventId);
          posterUrl = origin + (ogPath || ev.poster_image);
        } else {
          posterUrl = origin + '/images/1.jpg';
        }
        // og:url은 ref 포함 전체 URL → 카카오가 실제 공유 URL과 일치시켜 미리보기 표시
        const ref = req.query.ref || '';
        const pageUrl = origin + '/?event=' + eventId + (ref ? '&ref=' + encodeURIComponent(ref) : '');
        const dateStr = ev.event_date ? ev.event_date.replace(/-/g, '.') : '';
        const desc    = [ev.venue, dateStr ? dateStr + ' 개최' : ''].filter(Boolean).join(' | ') || '라스북 세미나에 신청하세요';
        const ogMeta = buildOgMeta({ title: ev.title, description: desc, imageUrl: posterUrl, pageUrl });
        const html = injectOgMeta(indexPath, ogMeta);
        return res.type('html').send(html);
      }
    } catch(e) {
      console.error('OG meta injection error:', e.message);
    }
  }

  // Default (no event / error): inject generic OG tags
  const defaultOg = buildOgMeta({
    title: '라스북 세미나 신청',
    description: '라스북 세미나에 신청하세요',
    imageUrl: origin + '/images/1.jpg',
    pageUrl: origin + '/'
  });
  const html = injectOgMeta(indexPath, defaultOg);
  res.type('html').send(html);
});

app.get('/referrer', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'public', 'referrer.html'));
});
app.get('/share', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'public', 'share.html'));
});
app.get('/ticket', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'public', 'ticket.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'public', 'admin.html'));
});
app.get('/admin/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'public', 'dashboard.html'));
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 라스북 세미나 시스템 서버 시작: http://0.0.0.0:${PORT}`);
  console.log(`📋 신청 페이지: http://localhost:${PORT}/`);
  console.log(`🔧 관리자 페이지: http://localhost:${PORT}/admin`);
  console.log(`📊 대시보드: http://localhost:${PORT}/admin/dashboard`);
});

module.exports = app;
