const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { res.redirect('/controller-unified.html'); });

// Claude API proxy エンドポイント
app.post('/api/scan-roster', async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
            { type: 'text', text: 'この野球のオーダー表から選手の背番号・名前・守備位置を読み取ってください。JSONのみで返してください。形式: {"players":[{"num":"背番号","name":"選手名","pos":"守備位置"},...]}\n背番号や守備位置がない場合は空文字にしてください。' }
          ]
        }]
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let lastState = null;

wss.on('connection', (ws, req) => {
  const isOverlay = (req.url || '').includes('overlay');
  if (isOverlay && lastState) ws.send(lastState);

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
