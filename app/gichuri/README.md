# 기추리 앱 (iOS · 안드로이드)

`https://gichul.site` 를 전체 화면 웹뷰로 띄우고, 웹뷰가 못 하는 일만 네이티브로 해 주는 앱입니다.
사이트(`site/`)는 이미 앱 모드를 알고 있습니다 — User-Agent 끝의 `GichuriApp` 을 보고
설치 배너를 끄고, 애플 로그인 버튼을 보여 주고, 아래 핸들러를 부릅니다.

| 사이트가 부르는 것 | 앱이 하는 일 |
|---|---|
| `callHandler('oauth', 로그인URL)` | 로그인 창(ASWebAuthenticationSession · Custom Tabs)을 띄우고, 돌아온 주소(`gichuri://auth?code=…`)를 글자 그대로 돌려줌. 닫으면 `null` |
| `callHandler('print')` | 시스템 인쇄 창 (여기서 PDF 저장도 됨) |
| `callHandler('share', {url,title})` | 링크 공유 시트 |
| `callHandler('share', {text,filename})` | 그 이름의 UTF-8 txt 파일로 공유 시트 |
| `Notification.requestPermission()` | 웹뷰에 없는 API 라 앱이 채워 넣음 → 알림 권한 창 (시험지 완성 알림) |

## 폴더

```
lib/main.dart          앱 시작·주소·색
lib/web_shell.dart     웹뷰 한 장, 이동 제한, 안전영역, 알림 등록
lib/native_actions.dart 위 표의 핸들러 구현
lib/push.dart          시험지 완성 알림(FCM) + 기기 등록
lib/offline_view.dart  인터넷이 없을 때 / 뜨는 동안
server/push-exam-ready/ 알림을 보내는 Supabase Edge Function
tool/                  아이콘·Xcode·애플 키 도우미
```

## 돌려 보기

```bash
flutter pub get
flutter run                 # 연결된 기기·시뮬레이터
flutter run -d <기기 id>     # flutter devices 로 확인
```

아이콘·첫 화면을 다시 만들 때 (brand/icon-1024.png 가 바뀌었을 때):

```bash
swift tool/make-splash-icon.swift ../../brand/icon-1024.png assets/splash-icon.png
swift tool/make-splash-icon.swift ../../brand/icon-1024.png assets/splash-icon-android12.png 1152 192 0
dart run flutter_launcher_icons
dart run flutter_native_splash:create
```

## 알아 둘 점

- **알림 설정 파일은 저장소에 없습니다.** `ios/Runner/GoogleService-Info.plist` 와
  `android/app/google-services.json` 은 Firebase 콘솔에서 받아 넣습니다(`준비하기.md`).
  없으면 알림만 빠진 채 그대로 빌드·실행됩니다.
- **안전영역(노치·홈 바)은 앱이 띄웁니다.** 웹뷰 안에서는 `env(safe-area-inset-*)` 가 0 으로 나와서
  사이트가 스스로 띄우지 못합니다. 그래서 앱이 그만큼 여백을 주고, 그 여백을 사이트 색(위는 바탕,
  아래는 탭바 색)으로 칠합니다. `site/` 는 고치지 않았습니다.
- **안드로이드 빌드 도구(AGP)는 8.13 으로 묶어 두었습니다.** `flutter_inappwebview` 와
  `flutter_web_auth_2` 안정판이 아직 AGP 9 에서 빌드되지 않습니다. 두 플러그인이 올라오면
  `android/settings.gradle.kts` 에서 Flutter 기본값으로 되돌리면 됩니다.
- 웹뷰 안에서 열리는 곳은 `gichul.site` 와 `*.supabase.co` 뿐입니다. 나머지(카카오페이 QR, 메일
  링크 등)는 사파리·크롬·다른 앱으로 넘깁니다.
