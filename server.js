const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// 静的ファイルを public フォルダから配信
app.use(express.static(path.join(__dirname, 'public')));

// 送信者以外の全クライアントにブロードキャスト
wss.on('connection', (ws) => {
  console.log('Client connected. Total:', wss.clients.size);
  ws.on('message', (data) => {
    const text = data.toString();
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
