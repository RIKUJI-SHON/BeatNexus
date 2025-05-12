// API設定
const isDevelopment = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// バックエンドのURL（本番環境ではRenderのURL、開発環境では相対パス）
const API_BASE_URL = isDevelopment 
  ? '' 
  : 'https://beatnexus.onrender.com'; // 実際のRenderのURL

// Socket.IO接続を作成する関数
function createSocketConnection() {
  return isDevelopment 
    ? io() 
    : io(API_BASE_URL, { 
        withCredentials: true,
        transports: ['websocket', 'polling'] // WebSocketを優先
      });
}

// API呼び出し関数
async function callApi(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  return fetch(url, {
    ...options,
    credentials: 'include' // クッキーを含める
  });
}

// 認証URLを生成する関数
function getAuthUrl(path) {
  return `${API_BASE_URL}${path}`;
} 