module.exports = {
  apps: [{
    name: 'lasbook',
    script: 'server.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      // 실제 서비스 도메인을 여기에 설정하세요
      // 예: SITE_URL: 'https://yourdomain.com'
      SITE_URL: 'https://3000-i8btla26ljzoa239fj10q-a402f90a.sandbox.novita.ai'
    }
  }]
};
