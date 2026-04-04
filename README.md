# 라스북 학부모 세미나 올인원 운영 시스템

학부모 대상 세미나를 위한 선착순 신청, 모바일 발권, 현장 출석 관리 시스템입니다.

## 페이지 구성

| 페이지 | URL | 설명 |
|--------|-----|------|
| 학부모 신청 | `/` | 모바일 신청 폼, 실시간 정원 현황 |
| 모바일 티켓 | `/ticket?code=XXX` | 바코드 포함 참가권 |
| 관리자 설정 | `/admin` | 세미나 정보, 포스터 제작기 |
| 대시보드 | `/admin/dashboard` | 실시간 현황, 출석 스캐너 |

## 빠른 시작

```bash
npm install
npm start
```

서버가 `http://localhost:3000` 에서 실행됩니다.

## 기본 관리자 비밀번호

`lasbook2025`

## 기술 스택

- Node.js + Express + SQLite (better-sqlite3)
- Vanilla JS + HTML5 Canvas
- JsBarcode + QRCode.js + html5-qrcode
