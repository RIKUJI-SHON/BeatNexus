// server.js – BeatNexus v0.4 〈MongoDB(Mongoose) プロフィール＋リアルタイム対戦〉
require('dotenv').config();

const express        = require('express');
const http           = require('http');
const path           = require('path');
const session        = require('express-session');
const passport       = require('passport');
const { Server }     = require('socket.io');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const mongoose       = require('mongoose');
const MongoStore     = require('connect-mongo');

// ── 0) MongoDB(Mongoose) 接続
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// ── 1) ユーザースキーマ作成
const { Schema, model } = mongoose;
const UserSchema = new Schema({
  googleId: { type: String, required: true, unique: true },
  email:    { type: String, required: true, unique: true },
  name:     { type: String, required: true },
  country:  { type: String, required: true },
  level:    { type: String, required: true },
});
const User = model('User', UserSchema);

// ── 2) アプリケーション設定
const app    = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json()); // JSON ボディの解析

// セッション共有
const sessionMw = session({
  secret: process.env.SESSION_SECRET || 'secret',
  store: MongoStore.create({ mongoUrl: MONGODB_URI }),
  resave: false,
  saveUninitialized: false,
});
app.use(sessionMw);

// Passport (Google OAuth)
app.use(passport.initialize());
app.use(passport.session());
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  '/auth/google/callback',
}, (accessToken, refreshToken, profile, done) => done(null, profile)));
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// 認証チェック
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// 静的ファイル配信＆ルート
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Google OAuth ルート
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// ← 登録済/未登録でリダイレクト先を分岐
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  async (req, res) => {
    try {
      const googleId = req.user.id;
      const existing = await User.findOne({ googleId });
      if (!existing) {
        // プロフィール未登録なら登録画面へ
        return res.redirect('/register.html');
      }
      // 登録済みならロビーへ
      return res.redirect('/lobby.html');
    } catch (err) {
      console.error('Profile lookup error:', err);
      return res.redirect('/lobby.html');
    }
  }
);

// 正しく閉じる
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

// プロフィール API
app.get('/api/user', ensureAuth, async (req, res) => {
  const googleId = req.user.id;
  const user = await User.findOne({ googleId });
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ name: user.name, country: user.country, level: user.level });
});
app.post('/api/user', ensureAuth, async (req, res) => {
  const googleId = req.user.id;
  const email    = req.user.emails[0].value;
  const { name, country, level } = req.body;
  try {
    await User.findOneAndUpdate(
      { googleId },
      { googleId, email, name, country, level },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Profile save error:', err);
    res.status(500).json({ error: 'Save failed' });
  }
});

// ── socket.io セッション共有
io.use((socket, next) => sessionMw(socket.request, {}, next));

// ── マッチング＆バトルロジック
let waitingQueue = [];
const roomStates = {};

io.on('connection', async socket => {
  const profile = socket.request.session.passport?.user;
  let displayName = profile?.displayName || 'Anonymous';
  let country = null;
  
  // データベースからプロフィール情報を取得
  if (profile) {
    try {
      const user = await User.findOne({ googleId: profile.id });
      if (user) {
        displayName = user.name;
        country = user.country;
      }
    } catch (err) {
      console.error('Error fetching user profile:', err);
    }
  }
  
  socket.userInfo = { displayName, country };

  socket.on('joinBattleQueue', () => {
    if (waitingQueue.includes(socket)) return;
    if (waitingQueue.length > 0) {
      const partner = waitingQueue.shift();
      const roomId  = `${socket.id}#${partner.id}`;
      socket.join(roomId);
      partner.join(roomId);
      socket.emit('matched', { roomId });
      partner.emit('matched', { roomId });
    } else {
      waitingQueue.push(socket);
    }
  });
  socket.on('cancelBattleQueue', () => {
    waitingQueue = waitingQueue.filter(s => s !== socket);
  });
  socket.on('disconnect', () => {
    waitingQueue = waitingQueue.filter(s => s !== socket);
  });

  socket.on('joinRoom', roomId => {
    socket.join(roomId);
    const st = roomStates[roomId] = roomStates[roomId] || {
      names: {}, countries: {}, order: [], turn: 1, sequenceStarted: false
    };
    st.names[socket.id] = socket.userInfo.displayName;
    st.countries[socket.id] = socket.userInfo.country;
    const members = Object.keys(st.names);
    if (members.length === 2 && !st.sequenceStarted) {
      const orderArr = Math.random() < 0.5 ? members : [members[1], members[0]];
      Object.assign(st, { order: orderArr, sequenceStarted: true });
      io.to(roomId).emit('ready', socket.id);
      io.to(roomId).emit('startSequence', { 
        order: orderArr, 
        names: st.names,
        countries: st.countries
      });
    }
  });

  ['offer','answer','ice'].forEach(evt =>
    socket.on(evt, (roomId, data) => socket.to(roomId).emit(evt, data))
  );

  // WebRTC再接続サポート - 接続問題があった場合に使用
  socket.on('requestReconnect', (roomId) => {
    console.log(`Room ${roomId}: Reconnection requested by ${socket.id}`);
    
    // ルームの状態をリセットせずに、相手側にも再接続要求を送信
    socket.to(roomId).emit('requestReconnect');
    
    // 10秒後に再度シグナリングを開始
    setTimeout(() => {
      // ルームがまだ存在するか確認
      const st = roomStates[roomId];
      if (st && Object.keys(st.names).length === 2) {
        console.log(`Room ${roomId}: Restarting signaling`);
        // 相手側に準備信号を送信
        io.to(roomId).emit('ready', socket.id);
      }
    }, 1000);
  });

  socket.on('turnEnd', roomId => {
    const st = roomStates[roomId];
    if (!st) return;
    st.turn++;
    if (st.turn > 4) {
      io.to(roomId).emit('battleFinished');
      delete roomStates[roomId];
    } else {
      io.to(roomId).emit('switchTurn', {
        turn:  st.turn,
        order: st.order,
        names: st.names,
        countries: st.countries
      });
    }
  });

  socket.on('timerTick', (roomId, sec) => {
    try {
      // タイマー値のデバッグログ（開発時は有効化すると便利）
      // console.log(`Timer tick: ${sec} from ${socket.id} in ${roomId}`);
      
      // roomStatesにroomIdが存在するかどうかで検証
      if (!roomId || !roomStates[roomId]) {
        // console.error(`Invalid room ID for timer tick: ${roomId}`);
        return;
      }
      
      // セッションに関係なく、指定されたルームIDにブロードキャスト
      io.to(roomId).emit('timerTick', sec);
    } catch (err) {
      console.error('Error in timerTick event:', err);
    }
  });
  socket.on('abortBattle', roomId => {
    socket.leave(roomId);
    io.to(roomId).emit('battleAborted');
    delete roomStates[roomId];
  });
  socket.on('chatMessage', ({ roomId, text }) =>
    io.to(roomId).emit('chatMessage', { name: socket.userInfo.displayName, text })
  );
  socket.on('reaction', (roomId, emoji) =>
    io.to(roomId).emit('reaction', emoji)
  );
});

// ── サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
