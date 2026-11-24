// ============================================================
//  App configuration
//  backend: 'firebase'  -> static hosting (GitHub Pages) + Firebase Auth/Firestore
//  backend: 'server'    -> self-hosted Node server (server.js) — it overrides this file automatically
// ============================================================
window.APP_CONFIG = {
  backend: 'firebase',
  // Paste your Firebase web app config here (Firebase console → Project settings → Your apps → Web app)
  firebase: {
    apiKey: 'AIzaSyCPXezAfgGNvCdlicW8qFwpe3wcHKz6Dg0',
    authDomain: 'sveiki-construction.firebaseapp.com',
    projectId: 'sveiki-construction',
    appId: '1:792171554158:web:a86a5618df6e95dce58d7f',
  },
};
