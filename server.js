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

wss.on('connection', (ws) => {
  if (lastState) ws.send(lastState);

  ws.on('message', (data) => {
    const text = data.toString();
    try { JSON.parse(text); lastState = text; } catch(e) {}
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === 1) client.send(text);
    });
  });

  ws.on('close', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
