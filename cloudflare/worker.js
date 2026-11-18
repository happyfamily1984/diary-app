// 일기장 서버 (Cloudflare Workers 무료 플랜) — 앱 전용, GitHub Actions·Cron·텔레그램 없이 동작합니다.
//
// 앱이 이 Worker 에 직접 요청합니다 (/api/...):
//   - 녹음을 보내면(POST /api/voice) 녹음 파일을 Worker 의 저장 공간(Durable Object)에 잠시 보관하고,
//     Gemini 로 받아써서 일기 저장소(diary/entries/YYYY-MM.json)에 글로 남긴 뒤 녹음은 지웁니다.
//   - "AI 분석하기"(POST /api/analyze)는 그 달의 일기와 아이디어를 함께 분석합니다.
//   - 앱을 열 때(POST /api/open) 밀린 받아쓰기와 지난달 분석을 처리합니다.
// 요청은 앱에 넣은 GitHub 토큰으로 확인합니다 (일기 저장소를 읽을 수 있어야 함).
//
// 필요한 Secrets (Settings → Variables and Secrets, Type: Secret):
//   GEMINI_API_KEY   Gemini API 키
//   GITHUB_TOKEN     daily 저장소만 선택한 Fine-grained 토큰 (Contents: Read and write)
//   GITHUB_REPO      happyfamily1984/daily
// 선택: GEMINI_MODEL, DIARY_TIMEZONE (기본 Asia/Seoul)
// 예전 텔레그램 연동이 남아 있으면 Worker 주소를 열 때 끊습니다 (TELEGRAM_BOT_TOKEN 이 있을 때).

const VERSION = "2026-11-18.1";
const MAX_SUBREQUESTS = 40;          // free plan allows 50 per invocation; keep headroom
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_PART = 1024 * 1024;      // Durable Object storage values are limited to 2 MB
const VOICE_PENDING = "🎙 (받아쓰는 중…)";
const MAX_VOICE_ATTEMPTS = 5;
const KINDS = { idea: "아이디어", diary: "일기" };
const FALLBACK_MODELS = ["gemini-flash-lite-latest"];
const RETRY_DELAYS = [3000, 8000];
const TRANSIENT = new Set([429, 500, 502, 503, 504, 524]);   // 524: long audio timed out — retry, then the faster model

const ANALYSIS_PROMPT = `너는 따뜻하고 통찰력 있는 기록 분석가야. 사용자가 한 달 동안 남긴 일기와 아이디어 메모를 읽고 한국어로 분석해 줘.
각 기록 앞에는 (일기) 또는 (아이디어) 표시가 있어.

아래 순서로, 각 항목은 이모지 제목 한 줄 + 짧은 문단이나 '- ' 목록으로 써.
📌 한 달 요약 (3~4문장)
🗓 주요 사건과 상황 (날짜와 함께)
💭 감정·심리 흐름 (주차별 변화, 감정이 크게 바뀐 날과 그 계기)
💡 아이디어 정리 (비슷한 것끼리 묶고, 일기 속 상황과 어떻게 이어지는지, 해 볼 만한 것 1~2개)
🔁 반복되는 패턴 (스트레스 요인, 에너지를 주는 것, 생각의 습관)
🌱 잘하고 있는 점
💡 다음 달을 위한 제안 (구체적이고 작은 행동 2~3개)
아이디어가 없으면 '💡 아이디어 정리'는 빼.

규칙:
- 기록에 근거해서만 말하고, 추측은 추측이라고 밝혀.
- 판단하거나 훈계하지 말고 친구처럼 다정하게.
- 의학적 진단은 하지 마. 자해·자살 생각이나 심한 우울 신호가 보이면 부드럽게 전문가 도움을 권하고 자살예방상담전화 109(24시간)를 알려 줘.
- 마크다운 문법(**, #, 표)은 쓰지 마. 전체 길이는 3,000자 이내.`;

const TRANSCRIBE_PROMPT = `이 음성은 사용자가 말로 남긴 일기나 아이디어 메모야. 들리는 그대로 한국어 문장으로 받아써 줘.
- '음', '어' 같은 군말과 반복은 빼고, 문장 부호를 넣어 읽기 좋게 다듬어.
- 내용을 요약하거나 바꾸거나 덧붙이지 마.
- 받아쓴 글만 출력해. 말소리가 없으면 '(내용 없음)' 이라고만 써.`;

class UserError extends Error {}

// ---------------------------------------------------------------- context

function makeCtx(env) {
  let used = 0;
  return {
    env,
    tz: env.DIARY_TIMEZONE || "Asia/Seoul",
    budgetLeft: () => MAX_SUBREQUESTS - used,
    fetch: (url, init) => { used++; return fetch(url, init); },
    dictionary: null,
  };
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

function parseMonth(arg, tz) {
  if (!arg) return todayLocal(tz).slice(0, 7);
  const m = arg.match(/^(\d{4})[-./]?(\d{1,2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12) throw new UserError("월은 2026-10 형식으로 적어 주세요");
  return `${m[1]}-${pad(+m[2])}`;
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
  for (let i = 0; file.state === "PROCESSING" && i < 5; i++) {       // some formats need a moment
    await new Promise(r => setTimeout(r, 2000));
    file = await (await ctx.fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`,
                                  { headers: { "x-goog-api-key": key } })).json();
  }
  return file;
}

async function transcribe(ctx, bytes, mime) {
  const file = await uploadToGemini(ctx, bytes, mime);
  const words = await dictionary(ctx);
  const text = await generate(ctx, TRANSCRIBE_PROMPT + dictionaryHint(words),
    [{ file_data: { mime_type: file.mimeType || mime, file_uri: file.uri } }, { text: "받아써 줘." }], 0);
  ctx.fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`,
            { method: "DELETE", headers: { "x-goog-api-key": ctx.env.GEMINI_API_KEY } }).catch(() => {});
  return `🎙 ${fixWords(text, words)}`;
}

const kindOf = e => (e.kind === "idea" ? "idea" : "diary");

async function analyzeMonth(ctx, month) {
  const entries = (await loadMonth(ctx, month)).filter(e => !e.pending);
  if (!entries.length) throw new UserError(`${month} 에 남긴 기록이 없어요.`);
  const words = await dictionary(ctx);
  const people = words.filter(w => w.note).map(w => `${w.correct}: ${w.note}`);
  const ideas = entries.filter(e => kindOf(e) === "idea").length;
  const lines = [`다음은 ${month} 한 달 동안의 기록 ${entries.length}개야 (일기 ${entries.length - ideas}개, 아이디어 ${ideas}개).`];
  if (people.length) lines.push("기록에 나오는 사람·단어: " + people.join(", "));
  lines.push("");
  for (const e of entries)
    lines.push(`[${e.time.slice(0, 16).replace("T", " ")}] (${KINDS[kindOf(e)]})${e.from ? ` (${e.from})` : ""} ${e.text}`);
  const text = await generate(ctx, ANALYSIS_PROMPT, [{ text: lines.join("\n") }], 0.7);
  const path = `diary/analysis/${month}.md`;
  const { sha } = await readWithSha(ctx, path);
  const res = await writeText(ctx, path, text.trim() + "\n", sha, `diary: analysis ${month}`);
  if (!res.ok) throw new Error(`github write ${path}: ${res.status}`);
  return text;
}

// ---------------------------------------------------------------- entries

async function upsert(ctx, entry, fields, message) {
  return updateMonth(ctx, entry.time.slice(0, 7), list => {
    let e = list.find(x => String(x.id) === String(entry.id));
    if (!e) { e = { ...entry }; list.push(e); }
    for (const [k, v] of Object.entries(fields)) { if (v === undefined) delete e[k]; else e[k] = v; }
  }, message);
}

// Transcribes every waiting voice entry whose recording is kept here. Returns true if some are left.
async function transcribePending(ctx, audio) {
  const months = [...new Set([todayLocal(ctx.tz).slice(0, 7), previousMonth(ctx.tz)])];
  let left = false;
  for (const month of months) {
    for (const e of await loadMonth(ctx, month)) {
      if (!e.pending || !e.voice || (e.attempts || 0) >= MAX_VOICE_ATTEMPTS) continue;
      if (ctx.budgetLeft() < 12) { left = true; continue; }
      const rec = await audio.get(e.id);
      if (!rec) {
        await upsert(ctx, e, { attempts: MAX_VOICE_ATTEMPTS, pending_error: "녹음 파일을 찾을 수 없어요" },
                     "diary: voice recording missing").catch(() => {});
        continue;
      }
      try {
        let text = await transcribe(ctx, rec.bytes, rec.mime);
        if (e.voice.caption) text += `\n${e.voice.caption}`;
        await upsert(ctx, e, { text, pending: undefined, attempts: undefined, pending_error: undefined },
                     "diary: transcribe voice entry");
        await audio.del(e.id);                      // the recording was only kept until it became text
      } catch (err) {
        const attempts = (e.attempts || 0) + 1;
        console.warn("transcription failed:", e.id, attempts, err.message);
        await upsert(ctx, e, { attempts, pending_error: String(err.message).slice(0, 300) },
                     "diary: voice transcription failed").catch(() => {});
        if (attempts < MAX_VOICE_ATTEMPTS) left = true;
      }
    }
  }
  return left;
}

// Last month's analysis, made once after the month ends (no Cron needed).
async function ensureMonthlyAnalysis(ctx) {
  const month = previousMonth(ctx.tz);
  if (ctx.budgetLeft() < 10 || await readText(ctx, `diary/analysis/${month}.md`) !== null) return;
  try { await analyzeMonth(ctx, month); }
  catch (e) { if (!(e instanceof UserError)) console.warn("monthly analysis failed:", e.message); }
}

// ---------------------------------------------------------------- Jobs Durable Object
// Keeps recordings until they are transcribed, and does slow work in an alarm: unlike work after
// a response (cut off after 30 s on the free plan), an alarm may run for minutes.

const jobs = env => env.JOBS.get(env.JOBS.idFromName("diary"));
const kickJobs = env => jobs(env).fetch("https://jobs/kick", { method: "POST" });

export class DiaryJobs {
  constructor(state, env) { this.state = state; this.env = env; }

  audioStore() {
    const s = this.state.storage;
    return {
      async get(id) {
        const meta = await s.get(`audio:${id}`);
        if (!meta) return null;
        const parts = await s.get([...Array(meta.parts).keys()].map(i => `audio:${id}:${i}`));
        const bytes = new Uint8Array(meta.size);
        let off = 0;
        for (let i = 0; i < meta.parts; i++) { const p = parts.get(`audio:${id}:${i}`); bytes.set(p, off); off += p.byteLength; }
        return { bytes, mime: meta.mime };
      },
      async del(id) {
        const meta = await s.get(`audio:${id}`);
        if (!meta) return;
        await s.delete([`audio:${id}`, ...[...Array(meta.parts).keys()].map(i => `audio:${id}:${i}`)]);
      },
    };
  }

  async fetch(request) {
    const url = new URL(request.url), s = this.state.storage;
    if (url.pathname === "/audio") {                 // keep a recording until it is transcribed
      const id = url.searchParams.get("id"), mime = request.headers.get("Content-Type") || "audio/wav";
      const bytes = new Uint8Array(await request.arrayBuffer());
      const parts = Math.ceil(bytes.byteLength / AUDIO_PART);
      const entries = {};
      for (let i = 0; i < parts; i++) entries[`audio:${id}:${i}`] = bytes.slice(i * AUDIO_PART, (i + 1) * AUDIO_PART);
      for (const [k, v] of Object.entries(entries)) await s.put(k, v);
      await s.put(`audio:${id}`, { mime, parts, size: bytes.byteLength, at: Date.now() });
    }
    if (url.pathname === "/status") {
      const audio = [...(await s.list({ prefix: "audio:" })).keys()].filter(k => k.split(":").length === 2).length;
      return Response.json({ alarm: await s.getAlarm(), lastRun: (await s.get("lastRun")) || null, recordings_kept: audio });
    }
    if (!(await s.getAlarm())) await s.setAlarm(Date.now() + 200);
    return new Response("ok");
  }

  async alarm() {
    const started = new Date().toISOString();
    await this.state.storage.put("lastRun", { started, state: "running" });
    try { await this.run(); await this.state.storage.put("lastRun", { started, finished: new Date().toISOString(), state: "done" }); }
    catch (e) { await this.state.storage.put("lastRun", { started, state: "error", error: String(e.message || e).slice(0, 300) }); }
  }

  // Recordings are only kept until they become text; drop any left over for two weeks
  // (e.g. the entry was deleted in the app before it was transcribed).
  async dropOldRecordings() {
    const s = this.state.storage, cutoff = Date.now() - 14 * 86400e3;
    for (const [key, meta] of await s.list({ prefix: "audio:" })) {
      if (key.split(":").length === 2 && meta.at < cutoff) await this.audioStore().del(key.slice(6));
    }
  }

  async run() {
    const ctx = makeCtx(this.env);
    let more = false;
    try { more = await transcribePending(ctx, this.audioStore()); }
    catch (e) { console.error("transcription round failed:", e.message); more = true; }
    try { await ensureMonthlyAnalysis(ctx); } catch (e) { console.error("monthly analysis failed:", e.message); }
    await this.dropOldRecordings();
    // Another round for what didn't fit in this one (50 outbound calls per run); failures back off.
    if (more) await this.state.storage.setAlarm(Date.now() + (ctx.budgetLeft() < 12 ? 2000 : 60_000));
  }
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

const ISO_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

async function onApi(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (!await appAuthorized(request, env)) return json({ ok: false, error: "토큰이 올바르지 않아요" }, 401);
  const ctx = makeCtx(env);
  const url = new URL(request.url), q = url.searchParams;
  try {
    if (url.pathname === "/api/voice") {             // a recording from the app → pending entry + kept audio
      const time = q.get("time"), kind = q.get("kind") === "diary" ? "diary" : "idea";
      if (!ISO_MINUTE.test(time || "")) throw new UserError("시간 형식이 올바르지 않아요");
      const mime = (request.headers.get("Content-Type") || "audio/wav").split(";")[0];
      const body = await request.arrayBuffer();
      if (!body.byteLength) throw new UserError("녹음이 비어 있어요");
      if (body.byteLength > MAX_AUDIO_BYTES) throw new UserError("녹음이 너무 길어요 (최대 약 10분)");
      const id = `v${Date.now()}`;
      const voice = { store: "worker", mime };
      if (q.get("caption")) voice.caption = q.get("caption").slice(0, 2000);
      await jobs(env).fetch(`https://jobs/audio?id=${id}`, { method: "PUT", headers: { "Content-Type": mime }, body });
      await upsert(ctx, { id, time }, { text: VOICE_PENDING, kind, voice, pending: true, source: "app" },
                   "diary: voice entry from app");
      return json({ ok: true, id, month: time.slice(0, 7) });
    }
    if (url.pathname === "/api/retry") {             // try a failed transcription again
      const id = q.get("id"), month = q.get("month");
      if (!/^\d{4}-\d{2}$/.test(month || "")) throw new UserError("달 형식이 올바르지 않아요");
      await updateMonth(ctx, month, list => {
        const e = list.find(x => String(x.id) === String(id));
        if (!e || !e.pending) return false;
        delete e.attempts; delete e.pending_error;
      }, "diary: retry voice transcription");
      await kickJobs(env);
      return json({ ok: true });
    }
    if (url.pathname === "/api/analyze") {
      const month = parseMonth(q.get("month"), ctx.tz);
      return json({ ok: true, month, text: await analyzeMonth(ctx, month) });
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
  const missing = ["GEMINI_API_KEY", "GITHUB_TOKEN", "GITHUB_REPO"].filter(k => !env[k]);
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
  let telegram = "사용 안 함";
  if (env.TELEGRAM_BOT_TOKEN) {                       // the app no longer uses Telegram: stop the old webhook
    const r = await ctx.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteWebhook`).catch(() => null);
    telegram = r && r.ok ? "연결 끊음" : "끊기 실패 (상관없음)";
  }
  let jobsStatus;
  try {
    if (!env.JOBS) jobsStatus = "JOBS 연결 없음 (배포 설정 확인 필요)";
    else { await kickJobs(env); jobsStatus = await (await jobs(env).fetch("https://jobs/status")).json(); }
  } catch (e) { jobsStatus = `오류: ${e.message}`; }
  return { ok: true, version: VERSION, github: "읽기·쓰기 권한 OK", gemini: "OK", jobs: jobsStatus, telegram,
           note: "앱 전용 서버입니다 (GitHub Actions·Cron·텔레그램 사용 안 함)" };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path.startsWith("/api/")) return await onApi(request, env);
      return Response.json(await setup(request, env), { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return Response.json({ ok: false, error: String(e.message || e) }, { status: 500, headers: CORS });
    }
  },
};
