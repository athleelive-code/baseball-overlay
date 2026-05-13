const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { res.redirect('/controller-unified.html'); });

let lastState = null;

wss.on('connection', (ws, req) => {
  const isOverlay = (req.url || '').includes('overlay');
  ws._isOverlay = isOverlay;

  // overlayのみlastStateで初期同期
  if (isOverlay && lastState) {
    ws.send(lastState);
  }

  ws.on('message', (data) => {
    const text = data.toString();
    try { JSON.parse(text); lastState = text; } catch(e) {}

    // controllerからの送信 → overlayにのみ転送
    // overlayからの送信 → 無視（overlayは送信しないが念のため）
    if (!isOverlay) {
      wss.clients.forEach((client) => {
        if (client._isOverlay && client.readyState === 1) {
          client.send(text);
        }
      });
    }
  });

  ws.on('close', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
