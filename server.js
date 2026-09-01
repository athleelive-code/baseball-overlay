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
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
            { type: 'text', text: 'この野球のオーダー表から打順・背番号・選手名・守備位置を読み取ってください。JSONのみで返してください。形式: {"players":[{"order":"打順","num":"背番号","name":"選手名","pos":"守備位置番号"},...]}\n項目がない場合は空文字にしてください。守備位置は番号で返してください: 投手=1,捕手=2,一塁手=3,二塁手=4,三塁手=5,遊撃手=6,左翼手=7,中堅手=8,右翼手=9,指名打者=DH' }
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

// ── Azure Speech（Text-to-Speech）プロキシ ──────────────────────────────────
// 生成済み音声はメモリにキャッシュし、同じ文言は再生成しない
const ttsCache = new Map();
const TTS_CACHE_MAX = 400;

// アクセストークンは10分間有効。9分でとり直す
let azureToken = null;
let azureTokenAt = 0;

async function getAzureToken(key, region) {
  const now = Date.now();
  if (azureToken && (now - azureTokenAt) < 9 * 60 * 1000) return azureToken;
  const r = await fetch(
    `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key } }
  );
  if (!r.ok) throw new Error('token failed: ' + r.status);
  azureToken = await r.text();
  azureTokenAt = now;
  return azureToken;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[m]
  ));
}

app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice, rate, style } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > 200) {
      return res.status(400).json({ error: 'text too long' });
    }

    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION || 'japaneast';
    if (!key) {
      return res.status(500).json({ error: 'AZURE_SPEECH_KEY not configured' });
    }

    const voiceName = voice || 'ja-JP-NanamiNeural';
    const spd = Math.max(0.5, Math.min(1.5, Number(rate) || 1.0));
    // SSML の rate は百分率で指定する
    const ratePct = Math.round((spd - 1) * 100);
    const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
    const styleName = style || '';

    // 追加の調整値
    const styleDeg = Math.max(0.01, Math.min(2, Number(req.body.styleDegree) || 1));
    const pitchNum = Math.max(-30, Math.min(30, Number(req.body.pitch) || 0));
    const pitchStr = (pitchNum >= 0 ? '+' : '') + pitchNum + '%';
    const volNum   = Math.max(-20, Math.min(20, Number(req.body.volume) || 0));
    const volStr   = (volNum >= 0 ? '+' : '') + volNum + 'dB';
    const pauseMs  = Math.max(0, Math.min(1200, Number(req.body.pause) || 0));

    const cacheKey = `${voiceName}|${styleName}|${styleDeg}|${rateStr}|${pitchStr}|${volStr}|${pauseMs}|${text}`;
    if (ttsCache.has(cacheKey)) {
      return res.json({ audio: ttsCache.get(cacheKey), cached: true });
    }

    // 読点・句点を区切りとして、指定の長さの間を挟む
    function withPauses(t, ms) {
      const esc = escapeXml(t);
      if (!ms) return esc;
      return esc
        .replace(/、/g, `、<break time="${ms}ms"/>`)
        .replace(/。/g, `。<break time="${Math.round(ms * 1.6)}ms"/>`);
    }

    const body = withPauses(text, pauseMs);
    const prosody =
      `<prosody rate="${rateStr}" pitch="${pitchStr}" volume="${volStr}">${body}</prosody>`;
    const inner = styleName
      ? `<mstts:express-as style="${escapeXml(styleName)}" styledegree="${styleDeg}">${prosody}</mstts:express-as>`
      : prosody;

    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
      `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="ja-JP">` +
      `<voice name="${escapeXml(voiceName)}">${inner}</voice></speak>`;

    const token = await getAzureToken(key, region);

    const r = await fetch(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
          'User-Agent': 'AthleeLive'
        },
        body: ssml
      }
    );

    if (!r.ok) {
      const msg = await r.text().catch(() => '');
      // トークン切れの可能性があるので次回は取り直す
      azureToken = null;
      return res.status(r.status).json({ error: 'TTS failed: ' + r.status + ' ' + msg.slice(0, 200) });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    const b64 = buf.toString('base64');

    if (ttsCache.size >= TTS_CACHE_MAX) {
      ttsCache.delete(ttsCache.keys().next().value);
    }
    ttsCache.set(cacheKey, b64);

    res.json({ audio: b64, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TTS が使える状態かをクライアントに知らせる
app.get('/api/tts/status', (req, res) => {
  res.json({ enabled: !!process.env.AZURE_SPEECH_KEY, provider: 'azure' });
});

// ── AI 一言コメント（Claude） ──────────────────────────────────────────────
app.post('/api/comment', async (req, res) => {
  try {
    const { context } = req.body || {};
    if (!context || typeof context !== 'string') {
      return res.status(400).json({ error: 'context is required' });
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const system =
      'あなたは高校野球のライブ配信で話す実況解説者です。' +
      '与えられた試合状況だけを根拠に、その場面にふさわしい一言を日本語で述べてください。\n' +
      '厳守事項：\n' +
      '・50〜90文字程度の短い文章にする\n' +
      '・与えられた情報にないことは絶対に書かない（過去の対戦、選手の特徴、心情の断定などは禁止）\n' +
      '・数字は与えられたものだけを使い、勝手に足したり推測したりしない\n' +
      '・落ち着いた丁寧語で話す。過度に煽らない\n' +
      '・音声で読み上げるため、記号や箇条書きは使わず、文章だけを返す\n' +
      '・前置きや説明は書かず、読み上げる文章のみを返す';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: context }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = (data.error && data.error.message) || 'comment failed';
      return res.status(r.status).json({ error: msg });
    }
    const text = (data.content && data.content[0] && data.content[0].text || '').trim();
    if (!text) return res.status(500).json({ error: 'empty response' });

    res.json({ text });
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
