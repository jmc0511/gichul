// 스토어 스크린샷을 찍을 때만 쓰는 장면 전환 스크립트.
//
// 쓰는 법: lib/web_shell.dart 에 아래 내용을 UserScript 로 하나 더 넣고
//   initialUserScripts: UnmodifiableListView<UserScript>([_shim, _shotDriver]),
// 로 바꾼 뒤 빌드 → store/스크린샷-다시찍기.md 의 명령으로 캡처 → 원래대로 되돌린다.
(function () {
  function at(ms, fn) { setTimeout(fn, ms); }
  function byText(re) {
    return [].slice.call(document.querySelectorAll('button,a')).filter(function (e) { return re.test(e.textContent); })[0];
  }
  function rows() { return [].slice.call(document.querySelectorAll('.omr-row')); }
  function start() {
    at(3000, function () { var b = byText(/건너뛰기/); if (b) b.click(); });
    // 2) 출제 조건이 보이게 내려 둠
    at(11000, function () { window.scrollTo(0, 760); });
    // 3) 예시 시험지 열기
    at(19000, function () {
      window.scrollTo(0, 0);
      location.hash = '#book';
      setTimeout(function () { var e = document.querySelector('.ex-open'); if (e) e.click(); }, 1200);
    });
    // 4) 정답 위치를 알아낸 뒤, 하나만 틀리게 골라 채점
    at(27000, function () {
      rows().forEach(function (r) { var b = r.querySelector('.bub'); if (b) b.click(); });
      var g = document.getElementById('grade'); if (g) g.click();
    });
    at(28500, function () {
      window.__keys = rows().map(function (r) {
        var bubs = [].slice.call(r.querySelectorAll('.bub'));
        for (var i = 0; i < bubs.length; i++) if (bubs[i].classList.contains('key')) return i;
        return -1;
      });
      var g = document.getElementById('grade'); if (g) g.click(); // 다시 풀기
    });
    at(29800, function () {
      // 단답·서술형에 모범답안을 적어 둔다 (예시 시험지의 실제 답)
      var texts = ['에이징(Aging)',
        'CPU를 오래 쓰는 프로세스는 하위(낮은 우선순위, 긴 퀀텀) 큐로 내려가고, 입출력 위주의 대화형 프로세스는 상위 큐에 머문다. 하위 큐에서 오래 기다린 프로세스는 에이징으로 상위 큐로 올려 기아를 막는다.'];
      var fields = [].slice.call(document.querySelectorAll('[placeholder*="답을 쓰세요"]'));
      fields.forEach(function (f, i) {
        if (texts[i] == null) return;
        f.value = texts[i];
        f.dispatchEvent(new Event('input', { bubbles: true }));
        f.dispatchEvent(new Event('change', { bubbles: true }));
      });
      var keys = window.__keys || [];
      rows().forEach(function (r, i) {
        var bubs = r.querySelectorAll('.bub');
        var want = keys[i];
        if (want == null || want < 0 || !bubs.length) return;
        // 두 번째 문제 하나만 일부러 틀리게 (채점 표시가 보이도록)
        var pick = (i === 1) ? (want + 1) % bubs.length : want;
        bubs[pick].click();
      });
      var g = document.getElementById('grade'); if (g) g.click();
      window.scrollTo(0, 0);
    });
    // 단답·서술형은 스스로 채점하는 자리 → '맞음'
    at(31200, function () {
      [].slice.call(document.querySelectorAll('button')).forEach(function (b) {
        if (b.textContent.trim() === '맞음') b.click();
      });
      window.scrollTo(0, 0);
    });
    // 5) 답안지(OMR) 열기
    at(38000, function () { var m = document.getElementById('mOmr'); if (m) m.click(); });
  }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();
