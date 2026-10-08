// 일기장 즉시 동기화 Worker (Cloudflare Workers 무료 플랜)
//
// 1분마다(Cron Trigger) 텔레그램에 아직 처리 안 된 메시지가 있는지 살짝 확인하고,
// 있으면 GitHub Actions 의 Diary 워크플로를 바로 실행시킵니다.
// 메시지를 읽거나 저장하지는 않습니다 — 저장은 지금처럼 GitHub Actions 가 합니다.
//
// 필요한 Secrets (Settings → Variables and Secrets):
//   TELEGRAM_BOT_TOKEN  일기 봇 토큰
//   GITHUB_TOKEN        daily 저장소만 선택한 Fine-grained 토큰 (Actions: Read and write)
//   GITHUB_REPO         happyfamily1984/daily

const WORKFLOW = "diary.yml";

async function pendingCount(env) {
  // offset 없이 부르면 메시지를 "읽음" 처리하지 않고 엿보기만 합니다.
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=0&limit=100`);
  const body = await res.json();
  if (!body.ok) throw new Error(`telegram: ${body.description}`);
  return body.result.length;
}

function github(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "diary-sync-worker",
      ...(init.headers || {}),
    },
  });
}

async function runActive(env) {
  for (const status of ["queued", "in_progress"]) {
    const res = await github(env, `/actions/workflows/${WORKFLOW}/runs?status=${status}&per_page=1`);
    if (!res.ok) throw new Error(`github runs: ${res.status}`);
    if ((await res.json()).total_count > 0) return true;
  }
  return false;
}

async function check(env, dispatch) {
  const pending = await pendingCount(env);
  if (pending === 0) return { pending, action: "nothing to do" };
  if (await runActive(env)) return { pending, action: "a run is already going" };
  if (!dispatch) return { pending, action: "would start a run (dry run)" };
  const res = await github(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (!res.ok) throw new Error(`github dispatch: ${res.status} ${await res.text()}`);
  return { pending, action: "started a run" };
}

export default {
  // Cron Trigger: "* * * * *"
  async scheduled(event, env, ctx) {
    const result = await check(env, true);
    console.log(JSON.stringify(result));
  },

  // Worker 주소를 브라우저로 열면 설정이 맞는지 확인만 합니다 (실행은 안 함).
  async fetch(request, env) {
    try {
      const missing = ["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "GITHUB_REPO"].filter((k) => !env[k]);
      if (missing.length) return Response.json({ ok: false, error: `Secrets 없음: ${missing.join(", ")}` });
      return Response.json({ ok: true, ...(await check(env, false)) });
    } catch (e) {
      return Response.json({ ok: false, error: String(e.message || e) });
    }
  },
};
