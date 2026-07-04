import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'fisler.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

function loadFisler() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return []; }
}
function saveFisler(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// sessions: { [telefon]: token }
function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveSessions(data) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}
function randomToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// Auth middleware
function auth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Oturum gerekli' });
  const sessions = loadSessions();
  const isValid = Object.values(sessions).some(s => s.token === token);
  if (!isValid) return res.status(401).json({ ok: false, error: 'Oturum süresi dolmuş' });
  next();
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// "openai" veya "anthropic" seçin
const PROVIDER = 'anthropic';

const PROMPT = `Bu bir Türk yazarkasa fişi/faturasıdır. Bilgileri oku ve SADECE geçerli JSON döndür, başka hiçbir açıklama yazma.
Format:
{
  "tarih": "GG.AA.YYYY",
  "fisNo": "...",
  "satici": "firma tam adı",
  "vkn": "vergi no veya TCKN (sadece rakam)",
  "kalemler": [
    { "oran": "%20", "matrah": "0,00", "kdv": "0,00", "toplam": "0,00" }
  ],
  "toplamKdv": "0,00",
  "genelToplam": "0,00"
}
Kurallar:
- Sayılar Türkçe formatında (binlik nokta, ondalık virgül): 1.234,56
- Fişte birden fazla KDV oranı varsa her oran için ayrı kalem oluştur.
- matrah = toplam - kdv (o orandaki).
- Emin olamadığın alanı boş string "" bırak.`;

// ---------- OpenAI ----------
async function readWithOpenAI(base64, mime) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
        ]
      }],
      response_format: { type: 'json_object' }
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return JSON.parse(data.choices[0].message.content);
}

// ---------- Anthropic (Claude) ----------
async function readWithAnthropic(base64, mime) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
          { type: 'text', text: PROMPT }
        ]
      }]
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  // Claude bazen ```json ... ``` ile sarabilir; temizle
  let txt = data.content[0].text.trim().replace(/^```json\s*/, '').replace(/```$/, '');
  return JSON.parse(txt);
}

// ---------- GİRİŞ ----------
app.post('/api/giris', (req, res) => {
  let { telefon } = req.body;
  if (!telefon) return res.status(400).json({ ok: false, error: 'Telefon numarası gerekli' });
  telefon = telefon.replace(/\D/g, '');
  if (telefon.length < 10) return res.status(400).json({ ok: false, error: 'Geçersiz numara' });

  const sessions = loadSessions();
  const token = randomToken();
  // Önceki oturumu sil (aynı anda tek giriş)
  sessions[telefon] = { token, giris: new Date().toLocaleString('tr-TR') };
  saveSessions(sessions);
  res.json({ ok: true, token, telefon });
});

app.post('/api/cikis', (req, res) => {
  const token = req.headers['x-session-token'];
  const sessions = loadSessions();
  for (const tel of Object.keys(sessions)) {
    if (sessions[tel].token === token) { delete sessions[tel]; break; }
  }
  saveSessions(sessions);
  res.json({ ok: true });
});

// ---------- API ucu ----------
app.post('/api/fis-oku', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Görsel yüklenmedi' });
    const base64 = req.file.buffer.toString('base64');
    const mime = req.file.mimetype || 'image/jpeg';

    const result = PROVIDER === 'anthropic'
      ? await readWithAnthropic(base64, mime)
      : await readWithOpenAI(base64, mime);

    // Kaydet
    const kayit = { id: Date.now(), dosya: req.file.originalname, eklenme: new Date().toLocaleString('tr-TR'), ...result };
    const fisler = loadFisler();
    fisler.unshift(kayit);
    saveFisler(fisler);

    res.json({ ok: true, data: kayit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Tüm fişleri listele
app.get('/api/fisler', auth, (req, res) => {
  res.json(loadFisler());
});

// Fiş sil
app.delete('/api/fisler/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const fisler = loadFisler().filter(f => f.id !== id);
  saveFisler(fisler);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Sunucu çalışıyor: http://localhost:${PORT}`));
