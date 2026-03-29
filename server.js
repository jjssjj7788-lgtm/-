const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use(express.static(path.join(__dirname, 'src', 'public')));

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

// Poster image upload endpoint
app.post('/api/upload-poster', upload.single('poster'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: '파일 업로드에 실패했습니다.' });
  }
  res.json({
    success: true,
    url: '/images/' + req.file.filename
  });
});

// ─── Page Routes ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'public', 'index.html'));
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
