// 시험지 완성 알림.
//
// 알림은 서버가 보낸다: 요청이 done·error 가 되면 Supabase 웹훅이 Edge Function 을
// 부르고, 그 함수가 이 기기 토큰으로 FCM 을 보낸다.
// (저장소의 supabase-push.sql · app/gichuri/server/push-exam-ready/index.ts)
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

class Push {
  Push._();
  static final Push instance = Push._();

  final _opened = StreamController<Map<String, String>>.broadcast();
  bool _ready = false;

  /// Firebase 설정 파일이 들어 있는 빌드인지. 없으면 알림만 빠지고 앱은 그대로 돈다.
  bool get ready => _ready;

  /// 알림을 눌러서 앱이 열렸을 때 딸려 온 값 (exam_id 등).
  Stream<Map<String, String>> get opened => _opened.stream;

  /// 토큰은 가끔 새로 발급된다. 그때마다 서버에 다시 등록해야 한다.
  /// (17.0.0 의 register()/onRegistered 는 FID 를 주는데, 서버가 FCM v1 의
  ///  token 으로 보내므로 지금은 등록 토큰을 그대로 쓴다.)
  Stream<String> get tokenRefreshed {
    if (!_ready) return const Stream<String>.empty();
    // ignore: deprecated_member_use
    return FirebaseMessaging.instance.onTokenRefresh;
  }

  Future<void> init() async {
    try {
      await Firebase.initializeApp();
      _ready = true;
    } catch (e) {
      // GoogleService-Info.plist / google-services.json 이 없는 빌드
      debugPrint('기추리: 알림 설정이 없어 알림 없이 실행합니다 ($e)');
      return;
    }
    FirebaseMessaging.onMessageOpenedApp.listen(_open);
    final first = await FirebaseMessaging.instance.getInitialMessage();
    if (first != null) _open(first);
  }

  void _open(RemoteMessage message) {
    _opened.add({for (final e in message.data.entries) e.key: '${e.value}'});
  }

  /// 'granted' · 'denied' · 'default' (사이트의 Notification.permission 과 같은 말)
  Future<String> status() async {
    if (!_ready) return 'denied';
    final settings = await FirebaseMessaging.instance.getNotificationSettings();
    return _say(settings.authorizationStatus);
  }

  /// 권한 창을 띄운다. 이미 정해져 있으면 그 상태를 그대로 돌려준다.
  Future<String> request() async {
    if (!_ready) return 'denied';
    final settings = await FirebaseMessaging.instance.requestPermission();
    return _say(settings.authorizationStatus);
  }

  String _say(AuthorizationStatus status) => switch (status) {
    AuthorizationStatus.authorized || AuthorizationStatus.provisional => 'granted',
    AuthorizationStatus.denied => 'denied',
    _ => 'default',
  };

  Future<String?> token() async {
    if (!_ready) return null;
    try {
      // 아이폰은 APNs 토큰이 들어온 다음에야 FCM 토큰이 나온다 (잠깐 기다려 본다)
      if (Platform.isIOS) {
        for (var i = 0; i < 5; i++) {
          if (await FirebaseMessaging.instance.getAPNSToken() != null) break;
          await Future<void>.delayed(const Duration(seconds: 2));
        }
      }
      // ignore: deprecated_member_use
      return await FirebaseMessaging.instance.getToken();
    } catch (e) {
      debugPrint('기추리: 알림 토큰을 받지 못했어요 ($e)');
      return null;
    }
  }
}

/// 기기 토큰과 "결과를 기다리는 요청 id"를 Supabase 에 등록한다 (register_push).
///
/// 주소·공개 키·로그인 토큰은 모두 웹뷰에서 읽어 오므로 앱에는 비밀값이 없다.
Future<bool> registerPushDevice({
  required String supabaseUrl,
  required String apiKey,
  required String deviceToken,
  required List<String> requestIds,
  String? accessToken,
}) async {
  final base = supabaseUrl.replaceAll(RegExp(r'/+$'), '');
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
  try {
    final request = await client.postUrl(Uri.parse('$base/rest/v1/rpc/register_push'));
    request.headers
      ..set('apikey', apiKey)
      ..set('Authorization', 'Bearer ${accessToken ?? apiKey}')
      ..contentType = ContentType.json;
    request.add(
      utf8.encode(
        jsonEncode({
          'p_device': deviceToken,
          'p_platform': Platform.isIOS ? 'ios' : 'android',
          'p_reqs': requestIds.take(30).toList(),
        }),
      ),
    );
    final response = await request.close();
    await response.drain<void>();
    if (response.statusCode >= 300) {
      debugPrint('기추리: 알림 등록이 거절됐어요 (${response.statusCode})');
    }
    return response.statusCode < 300;
  } catch (e) {
    debugPrint('기추리: 알림 등록 실패 ($e)');
    return false;
  } finally {
    client.close();
  }
}
