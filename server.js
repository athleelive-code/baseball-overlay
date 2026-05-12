const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.redirect('/controller-unified.html');
});

// 最後に受信した状態をキャッシュ
let lastState = null;

wss.on('connection', (ws) => {
  console.log('Client connected. Total:', wss.clients.size);

  // 新規接続時に最新状態を送信（overlay読み込み時に即同期）
  if(lastState) {
    ws.send(lastState);
  }

  ws.on('message', (data) => {
    const text = data.toString();
    // コントローラーからの状態更新をキャッシュ
    try {
      JSON.parse(text); // 有効なJSONのみキャッシュ
      lastState = text;
    } catch(e) {}

    console.log('Message received, broadcasting to', wss.clients.size - 1, 'clients');
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === 1) {
        client.send(text);
      }
    });
  });

  ws.on('close', () => {
    console.log('Client disconnected. Total:', wss.clients.size);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
