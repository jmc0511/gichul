// 앱 안에서만 지켜야 하는 규칙들. (화면은 웹뷰라 시뮬레이터·실기기에서 확인한다)
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gichuri/native_actions.dart';
import 'package:gichuri/web_shell.dart';

void main() {
  group('웹뷰 안에서 열 곳', () {
    bool inApp(String url) => staysInApp(WebUri(url));

    test('사이트와 Supabase 는 앱 안에서 연다', () {
      expect(inApp('https://gichul.site/#make'), isTrue);
      expect(inApp('https://gichul.site/privacy'), isTrue);
      expect(inApp('https://www.gichul.site/'), isTrue);
      expect(inApp('https://cjqhbckclrteazlwjruo.supabase.co/auth/v1/authorize'), isTrue);
    });

    test('그 밖의 주소는 바깥으로 넘긴다', () {
      expect(inApp('https://qr.kakaopay.com/Fabc'), isFalse);
      expect(inApp('mailto:beogo0511@naver.com'), isFalse);
      expect(inApp('https://accounts.google.com/o/oauth2/auth'), isFalse);
      expect(inApp('tel:118'), isFalse);
    });

    test('비슷해 보이는 주소에 속지 않는다', () {
      expect(inApp('https://gichul.site.example.com/'), isFalse);
      expect(inApp('https://notgichul.site/'), isFalse);
      expect(inApp('https://supabase.co.evil.com/'), isFalse);
    });
  });

  group('공유 파일 이름', () {
    test('끝에 .txt 를 붙인다', () {
      expect(shareFileName('운영체제 3장'), '운영체제 3장.txt');
      expect(shareFileName('운영체제 3장.txt'), '운영체제 3장.txt');
    });

    test('빈 이름과 폴더 구분자를 막는다', () {
      expect(shareFileName(null), '기추리 시험지.txt');
      expect(shareFileName('  '), '기추리 시험지.txt');
      expect(shareFileName('../../비밀'), '.. .. 비밀.txt');
    });
  });
}
