# 📔 diary-app

텔레그램 일기장의 **달력형 모바일 웹 앱**입니다. 휴대폰에서 열고 *홈 화면에 추가*하면 앱처럼 쓸 수 있어요.

- 이 저장소에는 화면 코드만 있고 일기 데이터는 없습니다.
- 일기와 월간 AI 분석은 접속 시 입력한 GitHub 토큰으로 private 일기 저장소에서 직접 읽어 오며,
  토큰은 그 기기 브라우저에만 저장됩니다.
- 원본 코드는 일기 저장소의 `web/` 폴더이고, 이 저장소는 GitHub Pages 배포용 사본입니다.

## 📱 안드로이드 앱 (APK)

`android/` 는 이 웹 앱을 전체 화면으로 여는 간단한 안드로이드 앱입니다.
`android/` 가 바뀌면 GitHub Actions 가 빌드해서 [Releases](../../releases/tag/apk) 에 올립니다.

폰에서 받기: https://github.com/happyfamily1984/diary-app/releases/download/apk/diary.apk

## ⚡ 일기장 서버 (Cloudflare Worker)

`cloudflare/worker.js` 가 앱의 서버입니다 — GitHub Actions·Cron·텔레그램을 쓰지 않습니다.

- 🎤 **말로 기록하기**: 앱이 녹음(16kHz WAV)을 보내면 Worker 의 저장 공간(Durable Object)에 잠시 보관했다가
  Gemini 로 받아써서 일기 저장소에 글로 남기고, 녹음은 지웁니다. 실패하면 녹음을 남겨 두고 앱에서 "다시 시도"할 수 있습니다.
- 📖 **일기** / 💡 **아이디어**: 기록마다 종류(`kind`)가 있고, 달력에 색으로 구별됩니다. 새 기록은 아이디어가 기본입니다.
- 🧠 **이 달의 분석**: 일기와 아이디어를 함께 분석합니다.

설정 후 Worker 주소를 브라우저로 한 번 열면 앱이 서버 주소를 알게 되고(예전 텔레그램 연결은 끊김), 설정을 점검합니다.
토큰들은 코드가 아니라 Worker 의 Secrets 에 넣습니다 (`GEMINI_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO`).

## 📱 APK 서명

`APK_KEYSTORE_B64`(키스토어 base64), `APK_KEYSTORE_PASSWORD` 비밀값을 이 저장소에 넣으면 그 키로 서명해서,
앱을 지우지 않고 덮어쓰기로 업데이트할 수 있습니다. 없으면 빌드마다 바뀌는 디버그 키로 서명합니다.
