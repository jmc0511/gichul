// 사이트가 window.flutter_inappwebview.callHandler(…) 로 부르는 일들.
// 이름과 인자는 site/app.js 의 native() 호출과 똑같이 맞춰야 한다.
//   oauth(로그인 URL) → 돌아온 주소 문자열 (취소하면 null)
//   print()           → 인쇄 창을 띄우고 닫히면 반환
//   share({url,title} | {text,filename}) → 공유 시트
//   notifyPermission() → 알림 권한 (Notification.requestPermission 자리)
import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:share_plus/share_plus.dart';

import 'main.dart';

/// 공유할 txt 파일 이름. 폴더 구분자가 들어오면 지운다.
String shareFileName(String? wanted) {
  var name = (wanted ?? '').replaceAll(RegExp(r'[/\\:\x00]'), ' ').trim();
  if (name.isEmpty) name = '기추리 시험지';
  if (!name.toLowerCase().endsWith('.txt')) name = '$name.txt';
  return name;
}

class NativeActions {
  NativeActions({
    required this.controller,
    required this.shareOrigin,
    required this.askNotifyPermission,
    required this.onRequestsChanged,
  });

  final InAppWebViewController controller;

  /// 아이패드에서 공유 시트가 튀어나올 자리.
  final Rect Function() shareOrigin;

  /// 알림 권한을 물어본다 ('granted' · 'denied' · 'default').
  final Future<String> Function() askNotifyPermission;

  /// 사이트가 "기다리는 요청" 목록을 바꿨을 때 (= 출제 요청을 보냈을 때).
  final void Function() onRequestsChanged;

  void register() {
    controller
      ..addJavaScriptHandler(
        handlerName: 'oauth',
        callback: (args) => openLogin(args.isEmpty ? null : args.first?.toString()),
      )
      ..addJavaScriptHandler(handlerName: 'print', callback: (_) => printPage())
      ..addJavaScriptHandler(
        handlerName: 'share',
        callback: (args) => share(args.isEmpty ? null : args.first),
      )
      ..addJavaScriptHandler(handlerName: 'notifyPermission', callback: (_) => askNotifyPermission())
      ..addJavaScriptHandler(
        handlerName: 'watchRequests',
        callback: (_) {
          onRequestsChanged();
          return true;
        },
      );
  }

  /// 구글·애플 로그인. 구글이 웹뷰 안 로그인을 막아서 ASWebAuthenticationSession
  /// (안드로이드는 Custom Tabs) 으로 띄우고, 돌아온 주소를 글자 그대로 사이트에 준다.
  Future<String?> openLogin(String? url) async {
    if (url == null || url.isEmpty) return null;
    try {
      return await FlutterWebAuth2.authenticate(
        url: url,
        callbackUrlScheme: kCallbackScheme,
        // 브라우저에 이미 로그인돼 있으면 그대로 쓰도록 (아이디·비밀번호를 다시 안 치게)
        options: const FlutterWebAuth2Options(preferEphemeral: false, timeout: 300),
      );
    } on PlatformException {
      return null; // 사용자가 창을 닫음(CANCELED) 등
    } catch (_) {
      return null;
    }
  }

  /// 지금 보고 있는 페이지를 iOS·안드로이드 인쇄 창으로. 이 창에서 PDF 저장도 된다.
  Future<bool> printPage() async {
    final job = await controller.printCurrentPage(
      settings: PrintJobSettings(handledByClient: true, jobName: '기추리 시험지'),
    );
    if (job == null) return true; // 창은 떴지만 끝을 알려 주지 않는 기기
    final closed = Completer<void>();
    job.onComplete = (completed, error) async {
      if (!closed.isCompleted) closed.complete();
    };
    try {
      await closed.future.timeout(const Duration(minutes: 10));
    } on TimeoutException {
      // 너무 오래 열려 있으면 그냥 사이트에 돌려준다
    }
    job.dispose();
    return true;
  }

  /// {url, title} 이면 링크를, {text, filename} 이면 그 이름의 txt 파일을 공유한다.
  Future<bool> share(Object? payload) async {
    final data = payload is Map
        ? {for (final e in payload.entries) '${e.key}': e.value}
        : const <String, Object?>{};
    final text = data['text']?.toString();
    final url = data['url']?.toString();
    final title = data['title']?.toString();

    if (text != null && text.isNotEmpty) {
      final name = shareFileName(data['filename']?.toString());
      // 이름을 그대로 쓰려고 임시 폴더를 하나 만들어 그 안에 넣는다
      final folder = await Directory.systemTemp.createTemp('gichuri-share');
      final file = File('${folder.path}/$name');
      // 사이트의 내려받기와 같게 BOM 을 붙여 둔다 (윈도 메모장에서 글자가 깨지지 않게)
      await file.writeAsString('\uFEFF$text', flush: true);
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(file.path, mimeType: 'text/plain', name: name)],
          subject: name,
          sharePositionOrigin: shareOrigin(),
        ),
      );
      return true;
    }

    if (url != null && url.isNotEmpty) {
      await SharePlus.instance.share(
        ShareParams(uri: Uri.parse(url), title: title, subject: title, sharePositionOrigin: shareOrigin()),
      );
    }
    return true;
  }

}
