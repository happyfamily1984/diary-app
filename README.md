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
