// 일기장 Worker (Cloudflare Workers 무료 플랜) — GitHub Actions 도, Cron 도 쓰지 않습니다.
//
// 텔레그램이 일기방에 새 메시지가 올 때마다 이 Worker 를 부릅니다(웹훅). 그때
//   - 글은 그대로, 음성은 Gemini 로 받아써서 일기 저장소(diary/entries/YYYY-MM.json)에 저장하고
//   - /cal /day /analyze /analysis 같은 명령에 답합니다.
// 앱은 "AI 분석하기"와 앱을 열 때의 점검(/api/...)을 이 Worker 에 직접 요청합니다.
// 지난달 분석은 매달 1일 이후 처음 들어오는 메시지나 앱 열기 때 자동으로 만듭니다.
// → 계정 공용 한도(Cron 5개, 하루 요청 10만 회)를 거의 쓰지 않습니다: 메시지 1개 = 요청 1회.
//
// 필요한 Secrets (Settings → Variables and Secrets, Type: Secret):
//   TELEGRAM_BOT_TOKEN  일기 봇 토큰
//   DIARY_CHAT_ID       일기방 chat ID
//   GEMINI_API_KEY      Gemini API 키
//   GITHUB_TOKEN        daily 저장소만 선택한 Fine-grained 토큰 (Contents: Read and write)
//   GITHUB_REPO         happyfamily1984/daily
// 선택: GEMINI_MODEL, DIARY_TIMEZONE (기본 Asia/Seoul), APP_URL
//
// 설치 후 Worker 주소를 브라우저로 한 번 열면 텔레그램 웹훅이 연결되고 설정을 점검합니다.

const VERSION = "2026-11-07.2";
const DEFAULT_APP_URL = "https://happyfamily1984.github.io/diary-app/";
const MAX_SUBREQUESTS = 40;          // free plan allows 50 per invocation; keep headroom
const VOICE_PENDING = "🎙 (음성 일기 — 받아쓰기 대기 중)";
const WEEKDAYS = "월화수목금토일";
const FALLBACK_MODELS = ["gemini-flash-lite-latest"];
const RETRY_DELAYS = [3000, 8000];
const TRANSIENT = new Set([429, 500, 503, 504]);

const ANALYSIS_PROMPT = `너는 따뜻하고 통찰력 있는 일기 분석가야. 사용자가 한 달 동안 쓴 일기를 읽고 한국어로 분석해 줘.

아래 순서로, 각 항목은 이모지 제목 한 줄 + 짧은 문단이나 '- ' 목록으로 써.
📌 한 달 요약 (3~4문장)
🗓 주요 사건과 상황 (날짜와 함께)
💭 감정·심리 흐름 (주차별 변화, 감정이 크게 바뀐 날과 그 계기)
🔁 반복되는 패턴 (스트레스 요인, 에너지를 주는 것, 생각의 습관)
🌱 잘하고 있는 점
💡 다음 달을 위한 제안 (구체적이고 작은 행동 2~3개)

규칙:
- 일기에 근거해서만 말하고, 추측은 추측이라고 밝혀.
- 판단하거나 훈계하지 말고 친구처럼 다정하게.
- 의학적 진단은 하지 마. 자해·자살 생각이나 심한 우울 신호가 보이면 부드럽게 전문가 도움을 권하고 자살예방상담전화 109(24시간)를 알려 줘.
- 마크다운 문법(**, #, 표)은 쓰지 마. 전체 길이는 2,500자 이내.`;

const TRANSCRIBE_PROMPT = `이 음성은 사용자가 말로 남긴 일기야. 들리는 그대로 한국어 문장으로 받아써 줘.
- '음', '어' 같은 군말과 반복은 빼고, 문장 부호를 넣어 읽기 좋게 다듬어.
- 내용을 요약하거나 바꾸거나 덧붙이지 마.
- 받아쓴 글만 출력해. 말소리가 없으면 '(내용 없음)' 이라고만 써.`;

const COMMANDS = [
  ["cal", "일기 달력 (예: /cal 2026-10)"],
  ["day", "그날 일기 보기 (예: /day 2026-10-08)"],
  ["analyze", "AI 월간 상황·심리 분석 (예: /analyze 2026-10)"],
  ["analysis", "저장된 월간 분석 다시 보기"],
  ["app", "달력 일기장 앱 열기"],
  ["help", "도움말"],
  ["id", "이 방의 chat ID"],
];

class UserError extends Error {}

// ---------------------------------------------------------------- context

function makeCtx(env, waitUntil = p => p) {
  let used = 0;
  const ctx = {
    env,
    waitUntil,
    tz: env.DIARY_TIMEZONE || "Asia/Seoul",
    chatId: env.DIARY_CHAT_ID ? Number(env.DIARY_CHAT_ID) : null,
    appUrl: env.APP_URL || DEFAULT_APP_URL,
    budgetLeft: () => MAX_SUBREQUESTS - used,
    fetch: (url, init) => { used++; return fetch(url, init); },
    dictionary: null,
  };
  return ctx;
}

// ---------------------------------------------------------------- time (in the diary's time zone)

function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
                                               hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute };
}
const pad = n => String(n).padStart(2, "0");

function isoLocal(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  const off = Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
  const a = Math.abs(off);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}${off >= 0 ? "+" : "-"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const todayLocal = tz => { const p = localParts(new Date(), tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const weekdayOf = iso => WEEKDAYS[(new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7];

function parseMonth(arg, tz) {
  if (!arg) return todayLocal(tz).slice(0, 7);
  const m = arg.match(/^(\d{4})[-./]?(\d{1,2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12) throw new UserError("월은 2026-10 형식으로 적어 주세요");
  return `${m[1]}-${pad(+m[2])}`;
}

function parseDay(arg, tz) {
  const today = todayLocal(tz);
  if (!arg) return today;
  if (arg === "어제" || arg === "yesterday") {
    const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  const m = arg.match(/^(?:(\d{4})[-./])?(\d{1,2})[-./](\d{1,2})$/);
  if (!m) throw new UserError("날짜는 2026-10-08 또는 10-08 형식으로 적어 주세요");
  const iso = `${m[1] || today.slice(0, 4)}-${pad(+m[2])}-${pad(+m[3])}`;
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d) || d.toISOString().slice(0, 10) !== iso) throw new UserError(`없는 날짜예요: ${arg}`);
  return iso;
}

function previousMonth(tz) {
  const p = localParts(new Date(), tz);
  return p.m > 1 ? `${p.y}-${pad(p.m - 1)}` : `${p.y - 1}-12`;
}

// ---------------------------------------------------------------- GitHub (diary data)

function github(ctx, path, init = {}) {
  return ctx.fetch(`https://api.github.com/repos/${ctx.env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "diary-worker",
      ...(init.headers || {}),
    },
  });
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function readText(ctx, path) {
  const res = await github(ctx, `/contents/${path}?ref=main&raw=${Date.now()}`,
                           { headers: { Accept: "application/vnd.github.raw+json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github read ${path}: ${res.status}`);
  return res.text();
}

async function readWithSha(ctx, path) {
  const res = await github(ctx, `/contents/${path}?ref=main&meta=${Date.now()}`);
  if (res.status === 404) return { text: null, sha: undefined };
  if (!res.ok) throw new Error(`github read ${path}: ${res.status}`);
  const f = await res.json();
  const text = f.encoding === "base64" && f.content ? b64decode(f.content) : await readText(ctx, path);
  return { text, sha: f.sha };
}

async function writeText(ctx, path, text, sha, message) {
  return github(ctx, `/contents/${path}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, branch: "main", sha, content: b64encode(text) }),
  });
}

const sortEntries = list => list.sort((a, b) =>
  a.time < b.time ? -1 : a.time > b.time ? 1 : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

async function loadMonth(ctx, month) {
  const text = await readText(ctx, `diary/entries/${month}.json`);
  return text ? JSON.parse(text) : [];
}

// Re-read, change, write back; retry when the app wrote the same file in between.
async function updateMonth(ctx, month, mutate, message) {
  const path = `diary/entries/${month}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text, sha } = await readWithSha(ctx, path);
    const entries = text ? JSON.parse(text) : [];
    const result = mutate(entries);
    if (result === false) return entries;          // nothing to change
    sortEntries(entries);
    const res = await writeText(ctx, path, JSON.stringify(entries, null, 1) + "\n", sha, message);
    if (res.ok) return entries;
    if (res.status !== 409 && res.status !== 422) throw new Error(`github write ${path}: ${res.status}`);
  }
  throw new Error(`github write ${path}: kept conflicting`);
}

// ---------------------------------------------------------------- dictionary (diary/dictionary.txt)

async function dictionary(ctx) {
  if (ctx.dictionary) return ctx.dictionary;
  const words = [];
  const text = await readText(ctx, "diary/dictionary.txt").catch(() => null);
  for (let line of (text || "").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [head, note = ""] = line.split("|");
    const [correct, wrong = ""] = head.split("=");
    const c = correct.trim();
    words.push({ correct: c, variants: wrong.split(",").map(w => w.trim()).filter(w => w && w !== c), note: note.trim() });
  }
  return (ctx.dictionary = words);
}

function dictionaryHint(words) {
  if (!words.length) return "";
  return "\n\n이 사람이 자주 말하는 이름·단어야. 비슷하게 들리면 반드시 이 표기로 적어:\n" + words.map(w =>
    `- ${w.correct}${w.note ? ` — ${w.note}` : ""}${w.variants.length ? ` ('${w.variants.join(", ")}' 처럼 들릴 수 있음)` : ""}`
  ).join("\n");
}

function fixWords(text, words) {
  const pairs = words.flatMap(w => w.variants.map(v => [v, w.correct])).sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return text;
  const table = Object.fromEntries(pairs);
  const re = new RegExp(pairs.map(([v]) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return text.replace(re, m => table[m]);
}

// ---------------------------------------------------------------- Gemini

async function geminiPost(ctx, path, body) {
  const models = [ctx.env.GEMINI_MODEL || "gemini-flash-latest", ...FALLBACK_MODELS];
  let error;
  for (const model of [...new Set(models)]) {
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      if (ctx.budgetLeft() < 3) throw new Error("subrequest budget exhausted");
      const res = await ctx.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": ctx.env.GEMINI_API_KEY },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      error = new Error(`Gemini ${res.status} (${model}): ${(await res.text()).slice(0, 200)}`);
      if (!TRANSIENT.has(res.status)) throw error;
      if (attempt < RETRY_DELAYS.length) await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  throw error;
}

async function generate(ctx, system, parts, temperature) {
  const data = await geminiPost(ctx, "generateContent", {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { temperature },
  });
  const cand = (data.candidates || [])[0];
  if (!cand) throw new Error(`Gemini 가 답하지 않았습니다: ${(data.promptFeedback || {}).blockReason || "응답 없음"}`);
  const text = ((cand.content || {}).parts || []).map(p => p.text || "").join("").trim();
  if (!text) throw new Error(`빈 응답 (finishReason=${cand.finishReason})`);
  return text.replaceAll("**", "");
}

// Audio goes through the Gemini Files API as raw bytes — no base64 work in the Worker.
async function uploadToGemini(ctx, bytes, mime) {
  const key = ctx.env.GEMINI_API_KEY;
  const start = await ctx.fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": key, "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mime,
    },
    body: JSON.stringify({ file: { display_name: "diary-voice" } }),
  });
  const url = start.headers.get("x-goog-upload-url");
  if (!start.ok || !url) throw new Error(`Gemini upload start ${start.status}`);
  const up = await ctx.fetch(url, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: bytes,
  });
  if (!up.ok) throw new Error(`Gemini upload ${up.status}`);
  let file = (await up.json()).file;
  for (let i = 0; file.state === "PROCESSING" && i < 5; i++) {       // video notes need a moment
    await new Promise(r => setTimeout(r, 2000));
    file = await (await ctx.fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`,
                                  { headers: { "x-goog-api-key": key } })).json();
  }
  return file;
}

async function transcribe(ctx, voice) {
  const info = await telegram(ctx, "getFile", { file_id: voice.file_id });
  const audio = await ctx.fetch(`https://api.telegram.org/file/bot${ctx.env.TELEGRAM_BOT_TOKEN}/${info.file_path}`);
  if (!audio.ok) throw new Error(`telegram file ${audio.status}`);
  const file = await uploadToGemini(ctx, await audio.arrayBuffer(), voice.mime);
  const words = await dictionary(ctx);
  const text = await generate(ctx, TRANSCRIBE_PROMPT + dictionaryHint(words),
    [{ file_data: { mime_type: file.mimeType || voice.mime, file_uri: file.uri } }, { text: "받아써 줘." }], 0);
  ctx.fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`,
            { method: "DELETE", headers: { "x-goog-api-key": ctx.env.GEMINI_API_KEY } }).catch(() => {});
  return `🎙 ${fixWords(text, words)}`;
}

async function analyzeMonth(ctx, month) {
  const entries = await loadMonth(ctx, month);
  if (!entries.length) throw new UserError(`${month} 에 기록된 일기가 없어요.`);
  const words = await dictionary(ctx);
  const people = words.filter(w => w.note).map(w => `${w.correct}: ${w.note}`);
  const lines = [`다음은 ${month} 한 달 동안의 일기 ${entries.length}개야.`];
  if (people.length) lines.push("일기에 나오는 사람·단어: " + people.join(", "));
  lines.push("");
  for (const e of entries) lines.push(`[${e.time.slice(0, 16).replace("T", " ")}]${e.from ? ` (${e.from})` : ""} ${e.text}`);
  const text = await generate(ctx, ANALYSIS_PROMPT, [{ text: lines.join("\n") }], 0.7);
  const path = `diary/analysis/${month}.md`;
  const { sha } = await readWithSha(ctx, path);
  const res = await writeText(ctx, path, text.trim() + "\n", sha, `diary: analysis ${month}`);
  if (!res.ok) throw new Error(`github write ${path}: ${res.status}`);
  return text;
}

const analysisMessage = (month, text) => `<b>🧠 ${month} 상황·심리 분석</b>\n\n${escapeHtml(text)}`;

// ---------------------------------------------------------------- Telegram

async function telegram(ctx, method, params) {
  const res = await ctx.fetch(`https://api.telegram.org/bot${ctx.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`telegram ${method}: ${body.description}`);
  return body.result;
}

const escapeHtml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function send(ctx, chatId, text, extra = {}) {
  const chunks = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf && buf.length + line.length + 1 > 4000) { chunks.push(buf); buf = ""; }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) chunks.push(buf);
  for (const chunk of chunks)
    await telegram(ctx, "sendMessage", { chat_id: chatId, text: chunk, parse_mode: "HTML",
                                         disable_web_page_preview: true, ...extra });
}


// ---------------------------------------------------------------- diary entries

function messageText(message) {
  const text = message.text || message.caption;
  const media = [["photo", "사진"], ["video", "영상"], ["document", "파일"], ["sticker", "스티커"], ["location", "위치"]];
  for (const [key, label] of media) {
    if (message[key]) {
      const extra = key === "sticker" && message.sticker.emoji ? ` ${message.sticker.emoji}` : "";
      return text ? `[${label}${extra}] ${text}` : `[${label}${extra}]`;
    }
  }
  return text || null;
}

function voiceOf(message) {
  if (message.voice) return { file_id: message.voice.file_id, mime: message.voice.mime_type || "audio/ogg" };
  if (message.audio) return { file_id: message.audio.file_id, mime: message.audio.mime_type || "audio/mpeg" };
  if (message.video_note) return { file_id: message.video_note.file_id, mime: "video/mp4" };
  return null;
}

function baseEntry(ctx, message) {
  const time = isoLocal(new Date(message.date * 1000), ctx.tz);
  const entry = { id: message.message_id, time };
  const from = message.from || {};
  if (message.chat.type !== "private" && from.first_name) entry.from = from.first_name;
  return entry;
}

async function upsert(ctx, entry, fields, message) {
  return updateMonth(ctx, entry.time.slice(0, 7), list => {
    let e = list.find(x => String(x.id) === String(entry.id));
    if (!e) { e = { ...entry }; list.push(e); }
    for (const [k, v] of Object.entries(fields)) { if (v === undefined) delete e[k]; else e[k] = v; }
  }, message);
}

async function react(ctx, message) {
  await telegram(ctx, "setMessageReaction", { chat_id: message.chat.id, message_id: message.message_id,
                                              reaction: [{ type: "emoji", emoji: "✍" }] }).catch(() => {});
}

async function replyTranscript(ctx, chatId, messageId, text) {
  await send(ctx, chatId, `<b>받아쓴 일기</b>\n${escapeHtml(text)}`,
             { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }).catch(() => {});
}

// Returns a function to run after the update is acknowledged (slow work), or null.
async function handleDiaryMessage(ctx, message, edited) {
  const voice = voiceOf(message);
  const entry = baseEntry(ctx, message);
  if (voice) {
    if (edited) return null;                       // only the caption changed; keep the transcript
    if (message.caption) voice.caption = message.caption;
    await upsert(ctx, entry, { text: VOICE_PENDING, voice, pending: true }, "diary: voice entry");
    await react(ctx, message);
    ctx.kick = true;                                 // transcription runs in the Jobs Durable Object
    return null;
  }
  const text = messageText(message);
  if (!text) return null;
  const fields = { text };
  if (edited && message.edit_date) fields.edited = isoLocal(new Date(message.edit_date * 1000), ctx.tz);
  await upsert(ctx, entry, fields, edited ? "diary: edit entry" : "diary: update entries");
  if (!edited) await react(ctx, message);
  return null;
}

const MAX_VOICE_ATTEMPTS = 5;

// Transcribes every waiting voice entry. Returns true if some are left for another round.
async function transcribePending(ctx) {
  const now = todayLocal(ctx.tz);
  const months = [...new Set([now.slice(0, 7), previousMonth(ctx.tz)])];
  let left = false;
  for (const month of months) {
    for (const e of await loadMonth(ctx, month)) {
      if (!e.pending || !e.voice || (e.attempts || 0) >= MAX_VOICE_ATTEMPTS) continue;
      if (ctx.budgetLeft() < 14) { left = true; continue; }
      try {
        let text = await transcribe(ctx, e.voice);
        if (e.voice.caption) text += `\n${e.voice.caption}`;
        await upsert(ctx, e, { text, pending: undefined, attempts: undefined, pending_error: undefined },
                     "diary: transcribe voice entry");
        if (ctx.chatId) await replyTranscript(ctx, ctx.chatId, e.id, text);
      } catch (err) {
        const attempts = (e.attempts || 0) + 1;
        console.warn("transcription failed:", e.id, attempts, err.message);
        await upsert(ctx, e, { attempts, pending_error: String(err.message).slice(0, 300) },
                     "diary: voice transcription failed").catch(() => {});
        if (attempts >= MAX_VOICE_ATTEMPTS && ctx.chatId)
          await send(ctx, ctx.chatId, `⚠️ 음성 일기(${e.time.slice(5, 16).replace("T", " ")}) 받아쓰기가 계속 실패했어요. ` +
                     `다시 보내 주시거나 앱에서 직접 적어 주세요.\n<code>${escapeHtml(String(err.message).slice(0, 150))}</code>`).catch(() => {});
        else left = true;
      }
    }
  }
  return left;
}

// ---------------------------------------------------------------- commands

function helpText(ctx) {
  return ["<b>📔 일기장 봇</b>", "", "이 방에 글을 쓰거나 🎙 음성 메시지를 보내면 시간과 함께 일기로 저장돼요.", "",
          ...COMMANDS.map(([c, d]) => `/${c} — ${escapeHtml(d)}`), "", `📱 앱: ${ctx.appUrl}`].join("\n");
}

async function monthCalendar(ctx, month) {
  const [y, m] = month.split("-").map(Number);
  const entries = await loadMonth(ctx, month);
  const counts = {};
  for (const e of entries) counts[+e.time.slice(8, 10)] = (counts[+e.time.slice(8, 10)] || 0) + 1;
  const rows = [[...WEEKDAYS].map(w => ` ${w}`).join(" ")];
  const first = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let cells = Array(first).fill("   ");
  for (let d = 1; d <= days; d++) {
    cells.push(`${String(d).padStart(2)}${counts[d] ? "•" : " "}`);
    if (cells.length === 7) { rows.push(cells.join(" ").trimEnd()); cells = []; }
  }
  if (cells.length) rows.push(cells.join(" ").trimEnd());
  const lines = [`<b>📅 ${y}년 ${m}월</b>`, `<pre>${rows.join("\n")}</pre>`];
  if (entries.length) lines.push(`기록한 날 ${Object.keys(counts).length}일 · 일기 ${entries.length}개`,
                                 "/day YYYY-MM-DD 로 그날 일기 보기");
  else lines.push("이 달에는 기록이 없어요.");
  return lines.join("\n");
}

async function dayView(ctx, day) {
  const list = (await loadMonth(ctx, day.slice(0, 7))).filter(e => e.time.startsWith(day));
  const [, m, d] = day.split("-").map(Number);
  const title = `<b>📖 ${day.slice(0, 4)}년 ${m}월 ${d}일 (${weekdayOf(day)})</b>`;
  if (!list.length) return `${title}\n기록이 없어요.`;
  return [title, ...list.map(e => `\n<b>${e.time.slice(11, 16)}</b>${e.from ? ` · ${escapeHtml(e.from)}` : ""}` +
                                  `${e.edited ? " <i>(수정됨)</i>" : ""}\n${escapeHtml(e.text)}`)].join("\n");
}

// Returns slow work to run after the update is acknowledged, or null.
async function handleCommand(ctx, chatId, command, arg) {
  if (command === "start" || command === "help") return send(ctx, chatId, helpText(ctx)), null;
  if (command === "app" || command === "book") return send(ctx, chatId, `📱 달력 일기장: ${ctx.appUrl}`), null;
  if (command === "cal") return send(ctx, chatId, await monthCalendar(ctx, parseMonth(arg, ctx.tz))), null;
  if (command === "day") return send(ctx, chatId, await dayView(ctx, parseDay(arg, ctx.tz))), null;
  if (command === "analysis" || command === "analyze") {
    const month = parseMonth(arg, ctx.tz);
    if (command === "analysis") {
      const saved = await readText(ctx, `diary/analysis/${month}.md`);
      await send(ctx, chatId, saved ? analysisMessage(month, saved)
                                    : `${month} 분석이 아직 없어요. /analyze ${month} 로 만들 수 있어요.`);
      return null;
    }
    await send(ctx, chatId, `🧠 ${month} 일기를 분석하는 중… (1분 안팎)`);
    ctx.kick = { analysis: { month, chatId } };
    return null;
  }
  await send(ctx, chatId, "알 수 없는 명령입니다. /help 를 입력해 보세요.");
  return null;
}

async function handleUpdate(ctx, update) {
  const edited = !!update.edited_message;
  const message = update.edited_message || update.message;
  if (!message) return null;
  const chatId = message.chat.id, isDiary = chatId === ctx.chatId;
  const text = (message.text || "").trim();
  if (!text.startsWith("/")) return isDiary ? handleDiaryMessage(ctx, message, edited) : null;
  if (edited) return null;
  const [head, ...rest] = text.split(/\s+/);
  const command = head.slice(1).split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim() || null;
  if (command === "id") return send(ctx, chatId, `chat ID: <code>${chatId}</code>`), null;
  if (!isDiary) return send(ctx, chatId, "일기장 방이 아니에요. /id 로 확인한 chat ID를 DIARY_CHAT_ID 에 등록하세요."), null;
  try { return await handleCommand(ctx, chatId, command, arg); }
  catch (e) {
    if (e instanceof UserError) { await send(ctx, chatId, `⚠️ ${escapeHtml(e.message)}`); return null; }
    throw e;
  }
}

// ---------------------------------------------------------------- background chores

// Last month's analysis, made once after the month ends (no Cron needed).
async function ensureMonthlyAnalysis(ctx) {
  const month = previousMonth(ctx.tz);
  if (ctx.budgetLeft() < 10 || await readText(ctx, `diary/analysis/${month}.md`) !== null) return;
  try {
    const text = await analyzeMonth(ctx, month);
    if (ctx.chatId) await send(ctx, ctx.chatId, analysisMessage(month, text));
  } catch (e) {
    if (!(e instanceof UserError)) console.warn("monthly analysis failed:", e.message);
  }
}

// ---------------------------------------------------------------- Jobs Durable Object
// Slow work (voice transcription, analyses) runs in a Durable Object alarm: unlike work after a
// response (waitUntil, cut off after 30 s on the free plan), an alarm may run for minutes.

async function kickJobs(env, payload = {}) {
  const stub = env.JOBS.get(env.JOBS.idFromName("diary"));
  await stub.fetch("https://jobs/kick", { method: "POST", body: JSON.stringify(payload) });
}

export class DiaryJobs {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    if (new URL(request.url).pathname === "/status")
      return Response.json({ alarm: await this.state.storage.getAlarm(), lastRun: (await this.state.storage.get("lastRun")) || null,
                             queue: (await this.state.storage.get("analysis")) || [] });
    const body = await request.json().catch(() => ({}));
    if (body.analysis) {
      const queue = (await this.state.storage.get("analysis")) || [];
      if (!queue.some(q => q.month === body.analysis.month)) queue.push(body.analysis);
      await this.state.storage.put("analysis", queue);
    }
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 200);
    return new Response("ok");
  }

  async alarm() {
    const started = new Date().toISOString();
    await this.state.storage.put("lastRun", { started, state: "running" });
    try { await this.run(); await this.state.storage.put("lastRun", { started, finished: new Date().toISOString(), state: "done" }); }
    catch (e) { await this.state.storage.put("lastRun", { started, state: "error", error: String(e.message || e).slice(0, 300) }); }
  }

  async run() {
    const ctx = makeCtx(this.env);
    const queue = (await this.state.storage.get("analysis")) || [];
    await this.state.storage.put("analysis", []);
    for (const { month, chatId } of queue) {
      try { await send(ctx, chatId, analysisMessage(month, await analyzeMonth(ctx, month))); }
      catch (e) { await send(ctx, chatId, `⚠️ ${escapeHtml(e.message)}`).catch(() => {}); }
    }
    let more = false;
    try { more = await transcribePending(ctx); } catch (e) { console.error("transcription round failed:", e.message); more = true; }
    try { await ensureMonthlyAnalysis(ctx); } catch (e) { console.error("monthly analysis failed:", e.message); }
    // Another round for what didn't fit in this one (50 outbound calls per run); failures back off.
    if (more) await this.state.storage.setAlarm(Date.now() + (ctx.budgetLeft() < 14 ? 2000 : 60_000));
  }
}

// ---------------------------------------------------------------- Telegram webhook

async function webhookSecret(env) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("diary-webhook:" + env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(hash)].slice(0, 24).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function onTelegram(request, env, waitUntil) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== await webhookSecret(env))
    return new Response("forbidden", { status: 403 });
  const ctx = makeCtx(env, waitUntil);
  const update = await request.json();
  let later;
  try { later = await handleUpdate(ctx, update); }
  catch (e) {
    console.error("update failed, Telegram will resend:", update.update_id, e.message);
    return new Response("retry", { status: 500 });
  }
  if (later) waitUntil(later().catch(e => console.error("background work failed:", e.message)));
  // Slow work goes to the Jobs Durable Object; every message also nudges it to catch up on leftovers.
  try { await kickJobs(env, ctx.kick && ctx.kick.analysis ? { analysis: ctx.kick.analysis } : {}); }
  catch (e) { console.error("could not start jobs:", e.message); }
  return new Response("ok");
}

// ---------------------------------------------------------------- app API (/api/...)

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type",
               "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (data, status = 200) => Response.json(data, { status, headers: { ...CORS, "Cache-Control": "no-store" } });

// The app proves who it is with its own GitHub token: it must be able to read the diary repo.
async function appAuthorized(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "diary-worker", Accept: "application/vnd.github+json" },
  });
  return res.ok;
}

async function onApi(request, env, waitUntil) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (!await appAuthorized(request, env)) return json({ ok: false, error: "토큰이 올바르지 않아요" }, 401);
  const ctx = makeCtx(env, waitUntil);
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/analyze") {
      const month = parseMonth(url.searchParams.get("month"), ctx.tz);
      const text = await analyzeMonth(ctx, month);
      if (ctx.chatId) waitUntil(send(ctx, ctx.chatId, analysisMessage(month, text)).catch(() => {}));
      return json({ ok: true, month, text });
    }
    if (url.pathname === "/api/open") {               // app opened: let the Jobs object catch up
      await kickJobs(env);
      return json({ ok: true });
    }
    return json({ ok: false, error: "unknown endpoint" }, 404);
  } catch (e) {
    return json({ ok: false, error: e.message }, e instanceof UserError ? 400 : 500);
  }
}

// ---------------------------------------------------------------- setup check (open the Worker URL)

async function setup(request, env) {
  const ctx = makeCtx(env);
  const missing = ["TELEGRAM_BOT_TOKEN", "DIARY_CHAT_ID", "GEMINI_API_KEY", "GITHUB_TOKEN", "GITHUB_REPO"].filter(k => !env[k]);
  if (missing.length) return { ok: false, error: `Secrets 없음: ${missing.join(", ")}` };
  const origin = new URL(request.url).origin;
  const read = await github(ctx, `/contents/.gitignore?ref=main`);
  if (!read.ok) return { ok: false, step: "GitHub 읽기", status: read.status,
                         hint: "GITHUB_REPO 가 happyfamily1984/daily 인지, 토큰에 daily 저장소가 선택됐는지 확인하세요" };
  // Tell the app where this Worker lives (diary/config.json); also proves write access.
  const cfgPath = "diary/config.json";
  const cfg = JSON.stringify({ worker_url: origin }, null, 1) + "\n";
  const cur = await readWithSha(ctx, cfgPath);
  if (cur.text !== cfg) {
    const w = await writeText(ctx, cfgPath, cfg, cur.sha, "diary: worker address");
    if (!w.ok) return { ok: false, step: "GitHub 쓰기 권한", status: w.status,
                        hint: "토큰 Permissions 에서 Contents 를 'Read and write' 로 바꾸세요" };
  }
  const g = await ctx.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-flash-latest"}`,
                            { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
  if (!g.ok) return { ok: false, step: "Gemini", status: g.status, hint: "GEMINI_API_KEY 값을 확인하세요" };
  try {
    await telegram(ctx, "setWebhook", {
      url: `${origin}/telegram`, secret_token: await webhookSecret(env), max_connections: 1,
      allowed_updates: ["message", "edited_message"],
    });
    await telegram(ctx, "setMyCommands", { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
    const info = await telegram(ctx, "getWebhookInfo", {});
    let jobs;
    try {
      if (!env.JOBS) jobs = "JOBS 연결 없음 (배포 설정 확인 필요)";
      else {
        await kickJobs(env);
        jobs = await (await env.JOBS.get(env.JOBS.idFromName("diary")).fetch("https://jobs/status")).json();
      }
    } catch (e) { jobs = `오류: ${e.message}`; }
    return { ok: true, version: VERSION, jobs, webhook: info.url, telegram_pending: info.pending_update_count,
             last_error: info.last_error_message || null, github: "읽기·쓰기 권한 OK", gemini: "OK",
             note: "텔레그램 메시지가 오면 바로 처리합니다 (GitHub Actions·Cron 사용 안 함)" };
  } catch (e) { return { ok: false, step: "텔레그램", error: e.message, hint: "TELEGRAM_BOT_TOKEN 값을 확인하세요" }; }
}

export default {
  async fetch(request, env, execCtx) {
    const waitUntil = p => execCtx.waitUntil(p);
    const path = new URL(request.url).pathname;
    try {
      if (path === "/telegram" && request.method === "POST") return await onTelegram(request, env, waitUntil);
      if (path.startsWith("/api/")) return await onApi(request, env, waitUntil);
      return Response.json(await setup(request, env), { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
    }
  },
};
