// 기추리 앱: gichul.site 를 전체 화면 웹뷰로 띄우고,
// 웹뷰가 못 하는 일(로그인 창 · 인쇄 · 공유 · 시험지 완성 알림)만 네이티브로 해 준다.
import 'package:flutter/material.dart';

import 'push.dart';
import 'web_shell.dart';

/// 앱이 처음 띄우는 화면. 사이트의 '출제하기' 탭.
const kHomeUrl = 'https://gichul.site/#make';

/// 알림을 눌렀을 때 바로 열 시험지 주소 (사이트가 ?exam=… 를 알아본다).
const kExamUrlPrefix = 'https://gichul.site/?exam=';

/// 기본 User-Agent 끝에 붙는 표시. 사이트가 이걸 보고 앱 모드로 바뀐다.
const kAppUserAgent = 'GichuriApp/1.0';

/// 로그인 창이 돌아오는 주소의 스킴. Info.plist · AndroidManifest · Supabase 에 같이 등록돼 있다.
const kCallbackScheme = 'gichuri';

const kBackground = Color(0xFF0F1218);
const kAccent = Color(0xFFCF3F63);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Push.instance.init(); // 설정이 없으면 알림만 빼고 그대로 실행된다
  runApp(const GichuriApp());
}

class GichuriApp extends StatelessWidget {
  const GichuriApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '기추리',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(seedColor: kAccent, brightness: Brightness.dark),
        scaffoldBackgroundColor: kBackground,
      ),
      home: const WebShell(),
    );
  }
}
