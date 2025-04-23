// server.js
console.log('=== server.js started ===');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// 静的ファイル (public フォルダ) を配信
app.use(express.static('public'));

// ルート確認
app.get('/', (_req, res) => res.send('BeatBoxArena server is running!'));

// WebSocket 接続テスト
io.on('connection', (socket) => {
  console.log('✅ Connected:', socket.id);
  socket.emit('hello', 'WebSocket is alive!');
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server started → http://localhost:${PORT}`);
});
