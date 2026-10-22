// 전체 화면 웹뷰. 사이트가 safe-area 를 직접 처리하므로 SafeArea 로 감싸지 않는다.
import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:url_launcher/url_launcher.dart';

import 'main.dart';
import 'native_actions.dart';
import 'offline_view.dart';
import 'push.dart';

/// 웹뷰 안에서 열어 주는 곳. 나머지는 사파리·크롬·다른 앱으로 넘긴다.
bool staysInApp(WebUri? url) {
  if (url == null) return false;
  switch (url.scheme.toLowerCase()) {
    case 'about':
    case 'data':
    case 'blob':
    case 'javascript':
      return true;
    case 'http':
    case 'https':
      break;
    default:
      return false; // mailto:, tel:, kakaotalk: …
  }
  final host = url.host.toLowerCase();
  return host == 'gichul.site' || host.endsWith('.gichul.site') || host.endsWith('.supabase.co');
}

/// 사이트에 없는 두 가지를 웹뷰에 채워 넣는다.
/// 1) Notification: 웹뷰에는 없는 API. 사이트가 출제 요청을 보낼 때 이걸 부르므로,
///    바로 그 순간에 앱이 알림 권한을 물어볼 수 있다. 알림 자체는 서버 푸시로 온다.
/// 2) 요청 목록이 바뀌면 알려 주기: 새 요청의 결과를 기다릴 기기로 등록하기 위해.
final _shim = UserScript(
  injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
  forMainFrameOnly: true,
  source: r'''
(function () {
  var call = function (name, arg) {
    var api = window.flutter_inappwebview;
    return api && api.callHandler ? api.callHandler(name, arg) : Promise.resolve(null);
  };
  if (!window.Notification) {
    var state = 'default';
    var N = function () { this.close = function () {}; };
    N.requestPermission = function (cb) {
      return call('notifyPermission').then(function (r) {
        state = r || 'default';
        if (cb) cb(state);
        return state;
      });
    };
    N._set = function (s) { state = s || 'default'; };
    Object.defineProperty(N, 'permission', { get: function () { return state; } });
    window.Notification = N;
  }
  try {
    var setItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, value) {
      setItem(key, value);
      if (key === 'gichul.myreqs') call('watchRequests', value);
    };
  } catch (e) {} // 저장소가 막힌 상태에서도 사이트는 그대로 떠야 한다
})();
''',
);

/// 알림 등록에 필요한 것을 웹뷰에서 읽어 온다 (앱에는 주소·키를 적어 두지 않는다).
const _siteStateJs = r'''
(function () {
  var cfg = window.GICHUL_CONFIG || {};
  var session = null, reqs = [];
  try {
    var key = Object.keys(localStorage).filter(function (k) { return /^sb-.+-auth-token$/.test(k); })[0];
    if (key) session = JSON.parse(localStorage.getItem(key));
  } catch (e) {}
  try { reqs = JSON.parse(localStorage.getItem('gichul.myreqs') || '[]'); } catch (e) {}
  return JSON.stringify({
    url: cfg.SUPABASE_URL || '',
    key: cfg.SUPABASE_KEY || '',
    token: (session && session.access_token) || '',
    reqs: Array.isArray(reqs) ? reqs.slice(0, 30) : []
  });
})()
''';

/// 사이트가 지금 쓰는 색. 노치·홈 바 자리를 같은 색으로 메우려고 읽는다.
/// (웹뷰 안에서는 env(safe-area-inset-*) 가 0 으로 나와서 사이트가 스스로 띄우지 못한다)
const _siteColorsJs = r'''
(function () {
  function rgb(value) {
    var n = (value || '').match(/\d+(\.\d+)?/g);
    if (!n || n.length < 3) return '';
    if (n.length > 3 && Number(n[3]) === 0) return '';
    return n[0] + ',' + n[1] + ',' + n[2];
  }
  var body = rgb(getComputedStyle(document.body).backgroundColor);
  // 폰에서는 아래 탭바(.tabs)가 화면 바닥에 붙어 있다. 그 아래 홈 바 자리는 탭바 색으로.
  var tabs = document.querySelector('.tabs');
  var style = tabs ? getComputedStyle(tabs) : null;
  var bar = style && style.position === 'fixed' ? rgb(style.backgroundColor) : '';
  return JSON.stringify({ body: body, bar: bar });
})()
''';

class WebShell extends StatefulWidget {
  const WebShell({super.key});

  @override
  State<WebShell> createState() => _WebShellState();
}

class _WebShellState extends State<WebShell> with WidgetsBindingObserver {
  final _webViewKey = GlobalKey();
  final _settings = InAppWebViewSettings(
    // 사이트가 이걸 보고 앱 모드로 바뀐다 (기본 UA 끝에 붙는다)
    applicationNameForUserAgent: kAppUserAgent,
    javaScriptEnabled: true,
    javaScriptCanOpenWindowsAutomatically: true,
    domStorageEnabled: true,
    databaseEnabled: true, // 자료함이 IndexedDB 를 쓴다
    allowsInlineMediaPlayback: true,
    mediaPlaybackRequiresUserGesture: false,
    allowsBackForwardNavigationGestures: true,
    allowsLinkPreview: false,
    isFraudulentWebsiteWarningEnabled: true,
    supportZoom: false,
    useShouldOverrideUrlLoading: true,
    useOnDownloadStart: true,
    supportMultipleWindows: true,
    allowFileAccess: true,
    allowContentAccess: true,
    mixedContentMode: MixedContentMode.MIXED_CONTENT_NEVER_ALLOW,
  );

  InAppWebViewController? _web;
  late final PullToRefreshController _pull;
  StreamSubscription<Map<String, String>>? _openedSub;
  StreamSubscription<String>? _tokenSub;
  String _registered = ''; // 같은 내용을 두 번 등록하지 않으려고
  Color _siteBackground = kBackground; // 사이트 바탕색 (위·옆 여백)
  Color? _siteBarBackground; // 아래 탭바 색 (홈 바 자리)
  bool _ready = false; // 첫 화면이 떴는지
  bool _failed = false; // 첫 로드가 실패했는지

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _pull = PullToRefreshController(
      settings: PullToRefreshSettings(color: kAccent, backgroundColor: kBackground),
      onRefresh: () => _web?.reload() ?? Future<void>.value(),
    );
    _openedSub = Push.instance.opened.listen(_openFromNotification);
    _tokenSub = Push.instance.tokenRefreshed.listen((_) => _registerPush(force: true));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _openedSub?.cancel();
    _tokenSub?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _registerPush();
      _matchSiteColors();
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await _web?.canGoBack() ?? false) {
          await _web?.goBack();
          return;
        }
        if (Platform.isAndroid) await SystemNavigator.pop();
      },
      child: Scaffold(
        backgroundColor: _siteBackground,
        // 아이폰은 사이트가 env(safe-area-inset-*) 로 직접 띄우므로 웹뷰가 화면 끝까지 간다.
        // 안드로이드 웹뷰는 그 값을 CSS 로 주지 않아서(아래 탭바가 내비게이션 바에 가림)
        // 앱이 그만큼 띄워 준다.
        body: Stack(
          children: [
            _inset(
              InAppWebView(
                key: _webViewKey,
                initialUrlRequest: URLRequest(url: WebUri(kHomeUrl)),
                initialSettings: _settings,
                initialUserScripts: UnmodifiableListView<UserScript>([_shim]),
                pullToRefreshController: _pull,
                onWebViewCreated: (controller) {
                  _web = controller;
                  NativeActions(
                    controller: controller,
                    shareOrigin: _shareOrigin,
                    askNotifyPermission: _askNotifyPermission,
                    onRequestsChanged: () => _registerPush(force: true),
                  ).register();
                },
                onLoadStop: (controller, url) async {
                  _pull.endRefreshing();
                  if (!_ready || _failed) {
                    setState(() {
                      _ready = true;
                      _failed = false;
                    });
                  }
                  await _afterLoad();
                },
                onReceivedError: (controller, request, error) {
                  _pull.endRefreshing();
                  if ((request.isForMainFrame ?? false) && !_ready) setState(() => _failed = true);
                },
                onReceivedHttpError: (controller, request, response) {
                  _pull.endRefreshing();
                  if ((request.isForMainFrame ?? false) && !_ready) setState(() => _failed = true);
                },
                shouldOverrideUrlLoading: (controller, action) async {
                  final url = action.request.url;
                  if (staysInApp(url)) return NavigationActionPolicy.ALLOW;
                  await _openOutside(url);
                  return NavigationActionPolicy.CANCEL;
                },
                // target=_blank · window.open 도 같은 규칙
                onCreateWindow: (controller, action) async {
                  final url = action.request.url;
                  if (staysInApp(url)) {
                    await controller.loadUrl(urlRequest: URLRequest(url: url));
                  } else {
                    await _openOutside(url);
                  }
                  return false;
                },
                onDownloadStartRequest: (controller, request) => _openOutside(request.url),
                onPermissionRequest: (controller, request) async =>
                    PermissionResponse(resources: request.resources, action: PermissionResponseAction.GRANT),
              ),
            ),
            if (_failed) OfflineView(onRetry: _retry),
            if (!_ready && !_failed) const LoadingView(),
          ],
        ),
      ),
    );
  }

  /// 노치·홈 바·가로 모드 옆 여백만큼 웹뷰를 띄운다.
  /// 위·옆은 사이트 바탕색, 아래는 탭바 색으로 메워서 이어져 보이게 한다.
  Widget _inset(Widget child) {
    final pad = MediaQuery.paddingOf(context);
    return Column(
      children: [
        Container(height: pad.top, color: _siteBackground),
        Expanded(
          child: Padding(
            padding: EdgeInsets.only(left: pad.left, right: pad.right),
            child: child,
          ),
        ),
        Container(height: pad.bottom, color: _siteBarBackground ?? _siteBackground),
      ],
    );
  }

  /// 사이트 색에 맞춰 바깥 여백과 상태표시줄 글자색을 맞춘다 (밝은 화면·어두운 화면 둘 다).
  Future<void> _matchSiteColors() async {
    final raw = await _web?.evaluateJavascript(source: _siteColorsJs);
    if (raw is! String || raw.isEmpty) return;
    Map<String, dynamic> colors;
    try {
      colors = jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final body = _toColor('${colors['body'] ?? ''}');
    final bar = _toColor('${colors['bar'] ?? ''}');
    if (body == null) return;

    final light = body.computeLuminance() > 0.5;
    SystemChrome.setSystemUIOverlayStyle(
      SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarBrightness: light ? Brightness.light : Brightness.dark,
        statusBarIconBrightness: light ? Brightness.dark : Brightness.light,
        systemNavigationBarColor: bar ?? body,
        systemNavigationBarIconBrightness: light ? Brightness.dark : Brightness.light,
      ),
    );
    if (mounted && (body != _siteBackground || bar != _siteBarBackground)) {
      setState(() {
        _siteBackground = body;
        _siteBarBackground = bar;
      });
    }
  }

  Color? _toColor(String rgb) {
    final parts = rgb.split(',');
    if (parts.length < 3) return null;
    final values = parts.map((p) => double.tryParse(p.trim())?.round() ?? -1).toList();
    if (values.any((v) => v < 0 || v > 255)) return null;
    return Color.fromARGB(255, values[0], values[1], values[2]);
  }

  Future<void> _openOutside(WebUri? url) async {
    if (url == null) return;
    try {
      await launchUrl(Uri.parse(url.toString()), mode: LaunchMode.externalApplication);
    } catch (_) {
      // 열어 줄 앱이 없으면 그냥 넘어간다
    }
  }

  void _retry() {
    setState(() => _failed = false);
    _web?.loadUrl(urlRequest: URLRequest(url: WebUri(kHomeUrl)));
  }

  /// 아이패드 공유 시트가 튀어나올 자리 (화면 가운데).
  Rect _shareOrigin() {
    final box = _webViewKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null) return const Rect.fromLTWH(0, 0, 1, 1);
    final at = box.localToGlobal(Offset.zero);
    return Rect.fromLTWH(at.dx + box.size.width / 2 - 1, at.dy + box.size.height / 2 - 1, 2, 2);
  }

  Future<void> _afterLoad() async {
    await _matchSiteColors();
    final state = await Push.instance.status();
    // 이미 허락받았으면 사이트가 다시 묻지 않게 알려 준다
    await _web?.evaluateJavascript(
      source: "window.Notification && window.Notification._set && window.Notification._set('$state');",
    );
    if (state == 'granted') await _registerPush();
  }

  /// 사이트의 Notification.requestPermission() 자리. 출제 요청을 보내는 순간 불린다.
  Future<String> _askNotifyPermission() async {
    if (!Push.instance.ready) return 'denied';
    var state = await Push.instance.status();
    if (state != 'default') {
      if (state == 'granted') await _registerPush();
      return state;
    }
    if (!mounted) return 'default';
    // 시스템 창을 바로 띄우면 한 번 거절하면 되돌리기 어려워서, 먼저 이유를 보여 준다
    final wants = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF1A1E26),
        title: const Text('시험지가 완성되면 알려 드릴까요?', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        content: const Text('출제는 보통 1~2분 걸려요. 다 되면 알림으로 알려 드릴게요.', style: TextStyle(height: 1.5)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('나중에', style: TextStyle(color: Color(0xFF98A1B0))),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            style: FilledButton.styleFrom(backgroundColor: kAccent, foregroundColor: Colors.white),
            child: const Text('알림 받기'),
          ),
        ],
      ),
    );
    if (wants != true) return 'default';
    state = await Push.instance.request();
    if (state == 'granted') await _registerPush();
    return state;
  }

  /// 이 기기를 "결과를 기다리는 요청"의 알림 받을 기기로 등록한다.
  Future<void> _registerPush({bool force = false}) async {
    final web = _web;
    if (web == null || !Push.instance.ready) return;
    if (await Push.instance.status() != 'granted') return;
    final device = await Push.instance.token();
    if (device == null) return;

    final raw = await web.evaluateJavascript(source: _siteStateJs);
    if (raw is! String || raw.isEmpty) return;
    Map<String, dynamic> site;
    try {
      site = jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final url = '${site['url'] ?? ''}';
    final key = '${site['key'] ?? ''}';
    final access = '${site['token'] ?? ''}';
    final reqs = (site['reqs'] as List? ?? const []).map((e) => '$e').toList();
    if (url.isEmpty || key.isEmpty || reqs.isEmpty) return;

    final mark = '$device|${reqs.join(",")}';
    if (!force && mark == _registered) return;
    final ok = await registerPushDevice(
      supabaseUrl: url,
      apiKey: key,
      accessToken: access.isEmpty ? null : access,
      deviceToken: device,
      requestIds: reqs,
    );
    if (ok) _registered = mark;
  }

  /// 알림을 눌러서 들어왔으면 그 시험지를 바로 띄운다.
  void _openFromNotification(Map<String, String> data) {
    final examId = data['exam_id'] ?? '';
    final url = examId.isEmpty ? kHomeUrl : '$kExamUrlPrefix$examId';
    _web?.loadUrl(urlRequest: URLRequest(url: WebUri(url)));
  }
}
