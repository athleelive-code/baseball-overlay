const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// オーダー表のPDFは大きいことがあるので、読み取りの入口だけ上限を広げる（先に置く）
app.use('/api/scan-team', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '10mb' }));
// HTML は毎回サーバーに確かめてから使わせる。
// OBS のブラウザソースは一度読んだページを強く抱え込むので、これが無いと
// デプロイしても古い画面が出たままになる（画像や音は今までどおりキャッシュする）
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
// 最初に開くのは、かんたんスコア（簡易版）。本体は /ctrl/ から
app.get('/', (req, res) => { res.redirect('/simple/'); });

// 旧URLからの転送（ホーム画面に古いアイコンが残っていても開ける）
app.get('/controller-unified.html', (req, res) => res.redirect(301, '/ctrl/'));
app.get('/speed.html',              (req, res) => res.redirect(301, '/spd/'));
app.get('/roster-pc.html',          (req, res) => res.redirect(301, '/roster/'));

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
            { type: 'text', text: 'この野球のオーダー表から選手情報を読み取ってください。JSONのみで返し、前後に説明を付けないでください。\n形式: {"tournament":"大会名","team":"チーム名","coach":"監督名","players":[{"order":"打順","num":"背番号","name":"選手名","yomi":"ふりがな","pos":"守備位置番号"},...]}\n\n決まり:\n・打順は先発9人に1〜9を入れ、控え選手は空文字にする\n・氏名の上や横に書かれたひらがな・カタカナは yomi に入れる（なければ空文字）\n・守備位置は必ず番号にする: 投手=1, 捕手=2, 一塁手=3, 二塁手=4, 三塁手=5, 遊撃手=6, 左翼手=7, 中堅手=8, 右翼手=9, 指名打者=DH\n・表に数字で書かれている場合はその数字をそのまま使う\n・控え選手の欄にある選手も players に含め、pos は空文字にする\n・用紙の上部にある大会名・チーム名・監督名も読み取る\\n・読み取れない項目は空文字にする' }
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
    if (text.length > 500) {
      return res.status(400).json({ error: 'text too long' });
    }

    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION || 'japaneast';
    if (!key) {
      return res.status(500).json({ error: 'AZURE_SPEECH_KEY not configured' });
    }

    const voiceName = voice || 'ja-JP-NanamiNeural';
    // 話し方（style）に対応しているのは一部の声だけ。
    // 非対応の声に指定するとエラーになるため、ここで落とす。
    const STYLE_OK = ['ja-JP-NanamiNeural'];
    const spd = Math.max(0.5, Math.min(1.5, Number(rate) || 1.0));
    // SSML の rate は百分率で指定する
    const ratePct = Math.round((spd - 1) * 100);
    const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
    const styleName = (STYLE_OK.indexOf(voiceName) >= 0) ? (style || '') : '';

    // 追加の調整値
    const styleDeg = Math.max(0.01, Math.min(2, Number(req.body.styleDegree) || 1));
    const pitchNum = Math.max(-30, Math.min(30, Number(req.body.pitch) || 0));
    const pitchStr = (pitchNum >= 0 ? '+' : '') + pitchNum + '%';
    const pauseMs  = Math.max(0, Math.min(1200, Number(req.body.pause) || 0));

    const cacheKey = `${voiceName}|${styleName}|${styleDeg}|${rateStr}|${pitchStr}|${pauseMs}|${text}`;
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
    // pitch は 0 のときは指定しない（環境によって弾かれることがある）
    const prosody = (pitchNum === 0)
      ? `<prosody rate="${rateStr}">${body}</prosody>`
      : `<prosody rate="${rateStr}" pitch="${pitchStr}">${body}</prosody>`;
    const inner = styleName
      ? `<mstts:express-as style="${escapeXml(styleName)}" styledegree="${styleDeg}">${prosody}</mstts:express-as>`
      : prosody;

    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
      `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="ja-JP">` +
      `<voice name="${escapeXml(voiceName)}">${inner}</voice></speak>`;

    const token = await getAzureToken(key, region);

    // Azure へ送る（失敗したら素のSSMLでもう一度だけ試す）
    async function synth(ssmlText) {
      return fetch(
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-24khz-160kbitrate-mono-mp3',
            'User-Agent': 'AthleeLive'
          },
          body: ssmlText
        }
      );
    }

    let r = await synth(ssml);

    if (!r.ok) {
      const firstErr = await r.text().catch(() => '');
      console.warn('[TTS] 1回目失敗', r.status, firstErr.slice(0, 300));

      // 声だけ指定した最小構成で再試行
      const plain =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ja-JP">` +
        `<voice name="${escapeXml(voiceName)}">${escapeXml(text)}</voice></speak>`;
      r = await synth(plain);

      if (!r.ok) {
        const msg = await r.text().catch(() => '');
        azureToken = null;
        console.warn('[TTS] 2回目も失敗', r.status, msg.slice(0, 300));
        return res.status(r.status).json({
          error: 'TTS failed: ' + r.status + ' ' + msg.slice(0, 200),
          voice: voiceName
        });
      }
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

// ── チーム用アプリ：オーダー表（写真・PDF）から選手を読み取る ────────────────
// 画像は AI（Anthropic 社の Claude）に送って文字を読み取る。読み取り以外には使わず、サーバーにも残さない。
// お金がかかるので、大会に登録されたチームのURL（id）からだけ受け付け、回数にも上限を付ける
const Anthropic = require('@anthropic-ai/sdk').default;
let anthropic = null;
const SCAN_LIMIT_PER_HOUR = 20;
const scanCount = {};   // id → [受け付けた時刻, ...]
const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    players: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          num:      { type: 'string', description: '背番号（数字だけ。なければ空）' },
          sei:      { type: 'string', description: '苗字' },
          mei:      { type: 'string', description: '名前（下の名前）。苗字と区別できなければ空' },
          yomi_sei: { type: 'string', description: '苗字のふりがな（ひらがな。なければ空）' },
          yomi_mei: { type: 'string', description: '名前のふりがな（ひらがな。なければ空）' },
          order:    { type: 'string', description: '打順 1〜9。控えは空' },
          pos:      { type: 'string', description: '守備位置の番号 1〜9 か DH。なければ空' },
          unsure:   { type: 'boolean', description: 'この行に自信のない文字が1つでもあれば true' },
          note:     { type: 'string', description: '自信のない文字や理由（例：「斉」か「斎」か不明）。なければ空' }
        },
        required: ['num', 'sei', 'mei', 'yomi_sei', 'yomi_mei', 'order', 'pos', 'unsure', 'note'],
        additionalProperties: false
      }
    }
  },
  required: ['players'],
  additionalProperties: false
};
const SCAN_PROMPT =
  'これは野球のオーダー表（メンバー表）です。手書きのこともあります。書かれている選手を全員読み取ってください。\n' +
  '決まり：\n' +
  '・苗字（sei）と名前（mei）は分けて入れる。ふりがなも苗字と名前に分ける\n' +
  '・背番号は数字だけ。打順は先発の9人に1〜9、控えの選手は空\n' +
  '・守備位置は番号にする：投手=1, 捕手=2, 一塁手=3, 二塁手=4, 三塁手=5, 遊撃手=6, 左翼手=7, 中堅手=8, 右翼手=9, 指名打者=DH。' +
  '「投」「捕」「一」「遊」などの略字や、表に書かれた数字もこの番号にする\n' +
  '・人の名前なので、似た形の漢字（斉/斎、崎/﨑、高/髙、沢/澤、辺/邊 など）や、崩れて読みにくい字は推測で決めつけない。' +
  '少しでも迷った行は unsure を true にし、note にどの字で迷ったかを書く\n' +
  '・二重線などで消された名前は入れない。読み取れない欄は空にする\n' +
  '・選手以外（監督・コーチ・記録員など）は入れない';

app.post('/api/scan-team', async (req, res) => {
  try {
    const { id, data, mimeType } = req.body || {};
    // 登録されたチームか
    let known = false;
    try { known = !!(teamList && JSON.parse(teamList).list.some((t) => t && t.id === id)); } catch (e) {}
    if (!validId(id) || !known) return res.status(403).json({ error: 'このURLでは読み取りを使えません' });
    const okTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    if (typeof data !== 'string' || !data || okTypes.indexOf(mimeType) < 0) {
      return res.status(400).json({ error: '写真（JPEG・PNG）かPDFを選んでください' });
    }
    // 回数の上限（1チーム1時間あたり）
    const now = Date.now();
    scanCount[id] = (scanCount[id] || []).filter((t) => now - t < 60 * 60 * 1000);
    if (scanCount[id].length >= SCAN_LIMIT_PER_HOUR) {
      return res.status(429).json({ error: '読み取りの回数が多すぎます。しばらくしてからもう一度' });
    }
    scanCount[id].push(now);
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: '読み取りの設定（APIキー）がサーバーにありません' });
    if (!anthropic) anthropic = new Anthropic();

    const file = mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data } };
    const response = await anthropic.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      // 断られたときは、別のモデルで読み直す（サーバー側の自動の代わり）
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema: SCAN_SCHEMA } },
      messages: [{ role: 'user', content: [file, { type: 'text', text: SCAN_PROMPT }] }]
    });
    if (response.stop_reason === 'refusal') return res.status(422).json({ error: '読み取れませんでした（別の写真で試してください）' });
    if (response.stop_reason === 'max_tokens') return res.status(422).json({ error: '選手が多すぎて読み切れませんでした。ページを分けて試してください' });
    const text = (response.content.find((b) => b.type === 'text') || {}).text || '';
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return res.status(502).json({ error: '読み取りの結果がこわれていました。もう一度試してください' }); }
    res.json({ players: Array.isArray(parsed.players) ? parsed.players : [] });
  } catch (err) {
    console.warn('[scan-team]', err && err.status, err && err.message);
    const status = err && err.status === 429 ? 429 : 500;
    res.status(status).json({ error: status === 429 ? 'AIが混み合っています。少し待ってからもう一度' : '読み取りに失敗しました' });
  }
});

let lastState = null;
let lastStateAt = 0;
// 復帰用キャッシュの有効期限（12時間）。これより古い状態は「前の試合」とみなして配らない。
const LAST_STATE_TTL = 12 * 60 * 60 * 1000;

// スポンサー画像とチームロゴはサーバーに預かる。
// これがないと、設定した端末（メンバー管理）を開いている間しか他の画面に届かず、
// 別の端末で開いたオーバーレイには何も出ない。試合をまたいで残しておきたいので
// 有効期限は付けない（サーバーが眠って起き直したときは消える）。
let lastAdCfg = null;
let lastAdCfgAt = 0;
let lastTeamCfg = null;
// ── 大会の参加チームと、チーム用アプリ（/team/?id=…）で登録した選手 ──────────
// 大会の前から登録しておけるように、ファイルにも書いて残す（サーバーが起き直しても戻せる）。
// ファイルが消える環境でも、かんたんスコアとスタッフのスマホが持っている分を送り直すので戻る。
// どちらも更新時刻（at）が新しいものだけ預かる（古い端末がつながり直しても上書きしない）
const DATA_FILE = path.join(__dirname, 'data', 'teams.json');
let teamList = null;          // {_teams:true, at, list:[{id, name}]} の文字列
let teamListAt = 0;
const teamPlayers = {};       // id → {_teamapp:true, id, at, players} の文字列
const teamPlayersAt = {};
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (saved.teamList) { teamList = saved.teamList; teamListAt = Number(JSON.parse(teamList).at) || 0; }
  Object.keys(saved.teamPlayers || {}).forEach((id) => {
    teamPlayers[id] = saved.teamPlayers[id];
    teamPlayersAt[id] = Number(JSON.parse(teamPlayers[id]).at) || 0;
  });
} catch (e) {}
let saveTimer = null;
function saveTeams() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ teamList, teamPlayers }));
    } catch (e) { console.warn('[teams] 保存できませんでした', e.message); }
  }, 1000);
}
const validId = (id) => typeof id === 'string' && /^[a-z0-9]{4,24}$/.test(id);

// ── 個人情報まわり ─────────────────────────────────────────────────────
// ・参加チームの一覧（各チームの URL の印を含む）は、かんたんスコアにだけ送る
// ・チーム用アプリには、自分のチームのことだけ（一覧の自分の行、今の試合で先攻か後攻か）を送る
// ・選手の登録は、同じチームの画面にだけ送る
// ・一覧から消したチームの選手は消す。最後の変更から一定の日数がたったら全部消す
const KEEP_DAYS = 60;
// つないできた画面の種類：'op'＝かんたんスコア / 'team'＝チーム用アプリ / 'other'＝配信画面など
function roleOf(req) {
  const q = new URL(req.url || '/', 'http://x').searchParams;
  if (q.get('simple') === '1') return { role: 'op' };
  if (q.get('team') === '1') return { role: 'team', teamId: validId(q.get('id')) ? q.get('id') : '' };
  return { role: 'other' };
}
function listIds() {
  try { return JSON.parse(teamList).list.map((t) => t && t.id).filter(Boolean); } catch (e) { return null; }
}
// チーム用アプリに送る一覧（自分の行だけ。消されていれば known:false）
function teamsFor(ws) {
  if (ws.role === 'op') return teamList;
  if (ws.role !== 'team' || !teamList) return null;
  let mine = null;
  try { mine = JSON.parse(teamList).list.find((t) => t && t.id === ws.teamId) || null; } catch (e) {}
  return JSON.stringify({ _teams: true, at: teamListAt, list: mine ? [mine] : [], known: !!mine });
}
// 試合の状態から、先攻・後攻のチームの印を外す。チーム用アプリには「自分は先攻か後攻か」だけを付ける
function ctlFor(ws, text, d) {
  if (ws.role === 'op' || !d || !('aid' in d || 'hid' in d)) return text;
  const c = Object.assign({}, d);
  delete c.aid; delete c.hid;
  if (ws.role === 'team') c.mySide = d.aid && d.aid === ws.teamId ? 'away' : d.hid && d.hid === ws.teamId ? 'home' : '';
  return JSON.stringify(c);
}
// 一覧を新しくする。一覧にないチームの選手は消す
function setTeamList(text, at) {
  teamList = text; teamListAt = at;
  const ids = listIds() || [];
  Object.keys(teamPlayers).forEach((id) => {
    if (ids.indexOf(id) < 0) { delete teamPlayers[id]; delete teamPlayersAt[id]; delete scanCount[id]; }
  });
  saveTeams();
  // チーム用アプリには、それぞれの自分の行を配り直す（消されたチームは known:false を受けて、手元の登録も消す）
  wss.clients.forEach((c) => {
    if (c.readyState !== 1 || (c.role !== 'op' && c.role !== 'team')) return;
    const t = teamsFor(c);
    if (t) c.send(t);
  });
}
// 最後の変更から KEEP_DAYS 日たったら、参加チームと選手を全部消す。
// 「全部消した」という印（空の一覧と今の時刻）を残すので、古い端末がつながり直しても戻らない
function expireOld() {
  const times = [teamListAt].concat(Object.keys(teamPlayersAt).map((k) => teamPlayersAt[k]));
  const last = Math.max.apply(null, times);
  const hasData = (listIds() || []).length > 0 || Object.keys(teamPlayers).length > 0;
  if (!hasData || !last || Date.now() - last < KEEP_DAYS * 24 * 60 * 60 * 1000) return;
  const now = Date.now();
  console.log('[teams] 最後の変更から' + KEEP_DAYS + '日たったので、参加チームと選手の登録を消しました');
  setTeamList(JSON.stringify({ _teams: true, at: now, list: [] }), now);
}
expireOld();
setInterval(expireOld, 60 * 60 * 1000);

wss.on('connection', (ws, req) => {
  Object.assign(ws, roleOf(req));
  // 接続直後に、十分新しい _ctl 状態があれば復帰用に送る。
  // 古い（前の試合の）状態は送らない → 各画面は先攻/後攻の初期表示のまま始まる。
  if (lastState && (Date.now() - lastStateAt) < LAST_STATE_TTL) {
    let d = null; try { d = JSON.parse(lastState); } catch (e) {}
    ws.send(ctlFor(ws, lastState, d));
  }
  if (lastAdCfg)   ws.send(lastAdCfg);
  if (lastTeamCfg) ws.send(lastTeamCfg);
  const t0 = teamsFor(ws);
  if (t0) ws.send(t0);

  ws.on('message', (data) => {
    const text = data.toString();
    let d = null;
    try { d = JSON.parse(text); } catch (e) {}
    // 全状態（コントローラー _ctl:true）だけを復帰用に保存する。
    // _pcEdit の部分更新や {_req:'state'} を保存すると、overlay 再接続時に
    // カウント・走者・スコアが消えた状態で初期化されてしまう。
    if (d && d._ctl === true) { lastState = text; lastStateAt = Date.now(); }
    // 広告は更新時刻（at）が新しいものだけ預かる。古い設定の端末が
    // つながり直しても、預かっている新しい設定を上書きしない
    if (d && d._adcfg) {
      const at = Number(d.at) || 0;
      if (!lastAdCfg || at >= lastAdCfgAt) { lastAdCfg = text; lastAdCfgAt = at; }
    }
    if (d && d._teamcfg) lastTeamCfg = text;
    // 問い合わせには、預かっているものをその場で返す。
    // （設定した端末が閉じていても届くようにする。中継もそのまま続ける）
    if (d && d._req === 'adcfg'   && lastAdCfg)   ws.send(lastAdCfg);
    if (d && d._req === 'teamcfg' && lastTeamCfg) ws.send(lastTeamCfg);

    // ── 参加チームの一覧：かんたんスコアからだけ受け付け、ほかへはそのまま中継しない ──
    if (d && d._teams) {
      if (ws.role === 'op' && Array.isArray(d.list)) {
        const at = Number(d.at) || 0;
        if (at < teamListAt) ws.send(teamList);          // 古い一覧なら、新しいほうを返す
        else if (at > teamListAt) setTeamList(text, at);
      }
      return;
    }
    if (d && d._req === 'teams') { const t = teamsFor(ws); if (t) ws.send(t); }

    // ── 選手の登録：自分のチームの分だけ受け付け、同じチームの画面にだけ送る ──
    if (d && d._teamapp) {
      if (ws.role !== 'team' || d.id !== ws.teamId || !Array.isArray(d.players)) return;
      const ids = listIds();
      if (ids && ids.indexOf(d.id) < 0) { const t = teamsFor(ws); if (t) ws.send(t); return; }   // 消されたチーム
      const at = Number(d.at) || 0;
      // 古い登録の端末がつながり直しても、新しい登録を上書きしない（新しいほうを返す）
      if (teamPlayers[d.id] && at < teamPlayersAt[d.id]) { ws.send(teamPlayers[d.id]); return; }
      teamPlayers[d.id] = text; teamPlayersAt[d.id] = at; saveTeams();
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === 1 && c.role === 'team' && c.teamId === d.id) c.send(text);
      });
      return;
    }
    if (d && d._req === 'teamapp') {
      if (ws.role === 'team' && d.id === ws.teamId && teamPlayers[d.id]) ws.send(teamPlayers[d.id]);
      return;
    }

    // ── それ以外はこれまでどおり中継（試合の状態は、相手に合わせてチームの印を外す）──
    const isCtl = d && d._ctl === true;
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === 1) client.send(isCtl ? ctlFor(client, text, d) : text);
    });
  });

  ws.on('close', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
