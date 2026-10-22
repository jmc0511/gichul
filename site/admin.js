// 기추리 관리 화면: admins 표에 등록된 계정으로 로그인했을 때만 admin_stats() 를 볼 수 있음
(function () {
  const $ = (id) => document.getElementById(id);
  const cfg = window.GICHUL_CONFIG || {};
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
  });

  // 무료 플랜 한도
  const DB_LIMIT = 500 * 1024 * 1024, STORAGE_LIMIT = 1024 * 1024 * 1024;

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k === "style") n.style.cssText = attrs[k];
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  const fmtBytes = (b) => b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB" : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
  const fmtSec = (s) => s == null ? "–" : s >= 60 ? `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초` : `${Math.round(s)}초`;
  const ago = (iso) => {
    if (!iso) return "기록 없음";
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
  };
  const when = (iso) => new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function card(k, v, d, cls) {
    return el("div", { class: "card" }, el("span", { class: "k", text: k }), el("span", { class: "v" + (cls ? " " + cls : "") }, v), d ? el("span", { class: "d", text: d }) : null);
  }

  function workerCard(s) {
    const seen = s.worker?.seen_at;
    const mins = seen ? (Date.now() - new Date(seen)) / 60000 : Infinity;
    const oldest = s.queue.oldest_pending ? (Date.now() - new Date(s.queue.oldest_pending)) / 60000 : 0;
    // 5분마다 기록하므로 12분 넘게 소식이 없으면 꺼진 것으로 봄
    let state = el("span", { class: "state ok", text: "작동 중" });
    if (mins > 12) state = el("span", { class: "state bad", text: "응답 없음" });
    else if (oldest > 10) state = el("span", { class: "state warn", text: "밀림" });
    const info = s.worker?.info || {};
    return el("div", { class: "card" },
      el("span", { class: "k", text: "NAS 처리기" }),
      el("span", { class: "v", style: "font-size:18px" }, state),
      el("span", { class: "d", text: `마지막 신호 ${ago(seen)}` + (info.since ? ` · ${ago(info.since).replace(" 전", "")}째 실행` : "") }));
  }

  function dayChart(days) {
    const max = Math.max(1, ...days.map((d) => d.total));
    const wrap = el("div", { style: "position:relative" });
    const tip = el("div", { class: "tip", hidden: true });
    const bars = el("div", { class: "bars", role: "img", "aria-label": "최근 14일 요청 수" });
    const h = (n) => `${(n / max) * 100}%`;
    for (const d of days) {
      const other = Math.max(0, d.total - d.done - d.error);
      const label = `${d.day.slice(5).replace("-", "/")} · 요청 ${d.total} (완료 ${d.done} · 실패 ${d.error}${other ? ` · 기타 ${other}` : ""})`;
      // 아래부터 완료 · 실패 · 기타, 맨 위 조각만 모서리를 둥글게
      const segs = [[d.done, ""], [d.error, "err"], [other, "other"]].filter(([n]) => n > 0);
      const b = el("button", { type: "button", class: "bar", "aria-label": label },
        el("span", { class: "col" }, ...segs.map(([n, cls], k) => el("i", { class: cls + (k === segs.length - 1 ? " end" : ""), style: `height:${h(n)}` }))));
      const show = () => {
        tip.textContent = label; tip.hidden = false;
        const r = b.getBoundingClientRect(), p = wrap.getBoundingClientRect();
        const x = Math.min(Math.max(r.left - p.left + r.width / 2, 90), p.width - 90);
        tip.style.left = x + "px";
        tip.style.top = (r.bottom - p.top - Math.max(12, (d.total / max) * r.height)) + "px";
      };
      b.addEventListener("mouseenter", show); b.addEventListener("focus", show);
      b.addEventListener("mouseleave", () => { tip.hidden = true; }); b.addEventListener("blur", () => { tip.hidden = true; });
      bars.append(b);
    }
    wrap.append(bars, tip);
    const ticks = el("div", { class: "ticks" }, ...days.map((d, i) => el("span", { text: i % 2 === days.length % 2 ? "" : String(+d.day.slice(8)) })));
    const legend = el("div", { class: "legend" }, el("span", { text: "완료" }), el("span", { class: "e", text: "실패" }), el("span", { class: "o", text: "기타(취소·진행 중)" }));
    return [legend, wrap, ticks];
  }

  function meter(label, used, limit) {
    const pct = Math.min(100, (used / limit) * 100);
    return el("div", { class: "meter" },
      el("div", { class: "row" }, el("span", { text: label }), el("b", { text: `${fmtBytes(used)} / ${fmtBytes(limit)}` })),
      el("div", { class: "track" }, el("div", { class: "fill" + (pct > 80 ? " hi" : ""), style: `width:${Math.max(pct, 0.5)}%` })));
  }

  const MARKS = ["①", "②", "③", "④", "⑤"];
  function reportsBox(reports) {
    const box = el("section", { class: "box" }, el("h2", null, "문제 신고", el("small", { text: reports.length ? `처리 안 한 신고 ${reports.length}개` : "처리할 신고 없음" })));
    // 같은 문제에 대한 신고는 하나로 묶어서 보여 줌
    const seen = new Set();
    for (const r of reports) {
      const k = r.exam_id + ":" + r.q_index;
      if (seen.has(k)) continue;
      seen.add(k);
      const q = r.question || {};
      const ans = q.type === "mc" ? `${MARKS[(q.answer || 1) - 1] || "?"} ${(q.choices || [])[(q.answer || 1) - 1] || ""}` : String(q.answer ?? "");
      const notes = reports.filter((x) => x.exam_id === r.exam_id && x.q_index === r.q_index);
      const done = el("button", { type: "button", class: "btn", text: "처리 완료" });
      done.addEventListener("click", async () => {
        done.disabled = true;
        const { error } = await sb.rpc("admin_resolve_report", { rid: r.id });
        if (error) { done.disabled = false; alert("처리하지 못했어요: " + error.message); return; }
        load();
      });
      box.append(el("div", { class: "report-card" },
        el("div", { class: "rc-head" },
          el("b", { text: `${r.title || "시험지"} · ${r.q_index + 1}번` }),
          el("span", { class: "pill error", text: `신고 ${r.same_q}건` }),
          el("a", { href: `./?exam=${r.exam_id}`, target: "_blank", rel: "noopener", text: "시험지 열기" })),
        el("p", { class: "rc-q", text: q.question || "(문제 없음)" }),
        q.type === "mc" ? el("ol", { class: "rc-choices" }, ...(q.choices || []).map((c, k) => el("li", { class: k + 1 === q.answer ? "key" : "", text: `${MARKS[k]} ${c}` }))) : null,
        el("p", { class: "rc-a", text: "정답: " + ans }),
        q.explanation ? el("p", { class: "foot", text: "해설: " + q.explanation }) : null,
        el("ul", { class: "rc-notes" }, ...notes.map((x) => el("li", null, el("b", { text: x.reason }), x.note ? ` — ${x.note}` : "", el("span", { class: "foot", text: ` · ${when(x.created_at)}` })))),
        done));
    }
    return box;
  }

  // NAS가 자동으로 처리한 신고 (고친 것은 되돌릴 수 있음)
  const AUTO_LABEL = { fixed: ["고침", "done"], ok: ["문제없음", ""], stale: ["건너뜀", ""], undone: ["되돌림", "error"] };
  const ansText = (q) => q.type === "mc" ? `${MARKS[(q.answer || 1) - 1] || "?"} ${(q.choices || [])[(q.answer || 1) - 1] || ""}` : String(q.answer ?? "");
  function autoBox(autos) {
    const box = el("section", { class: "box" }, el("h2", null, "신고 자동 처리", el("small", { text: "NAS가 자료와 대조해 처리 · 최근 30일" })));
    if (!autos.length) { box.append(el("p", { class: "foot", text: "아직 자동 처리한 신고가 없어요." })); return box; }
    for (const r of autos) {
      const [label, cls] = AUTO_LABEL[r.auto_status] || [r.auto_status, ""];
      const b = r.auto_before || {}, a = r.auto_after || {};
      let undo = null;
      if (r.auto_status === "fixed") {
        undo = el("button", { type: "button", class: "btn", text: "원래 문제로 되돌리기" });
        undo.addEventListener("click", async () => {
          undo.disabled = true;
          const { error } = await sb.rpc("admin_undo_autofix", { rid: r.id });
          if (error) { undo.disabled = false; alert(/changed_since/.test(error.message) ? "그 뒤로 문제가 또 바뀌어서 되돌릴 수 없어요." : "되돌리지 못했어요: " + error.message); return; }
          load();
        });
      }
      box.append(el("div", { class: "report-card" },
        el("div", { class: "rc-head" },
          el("b", { text: `${r.title || "시험지"} · ${r.q_index + 1}번` }),
          el("span", { class: "pill " + cls, text: label }),
          el("span", { class: "foot", text: `신고 ${r.same_q}건 · ${r.reason} · ${when(r.auto_at)}` }),
          el("a", { href: `./?exam=${r.exam_id}`, target: "_blank", rel: "noopener", text: "시험지 열기" })),
        el("p", { class: "rc-a", text: r.auto_note || "–" }),
        r.auto_status === "fixed" || r.auto_status === "undone" ? el("div", { class: "foot" },
          el("div", { text: `전: ${String(b.question || "").slice(0, 140)} → 정답 ${ansText(b)}` }),
          el("div", { text: `후: ${String(a.question || "").slice(0, 140)} → 정답 ${ansText(a)}` })) : null,
        undo));
    }
    return box;
  }

  function render(s, reports, autos) {
    const t = s.today, u = s.usage;
    const storage = u.request_images.bytes + u.exam_figures.bytes;
    const days = s.days.map((d) => ({ ...d, day: String(d.day) }));
    const failures = s.failures || [];

    const tableOf = (heads, rows) => el("div", { class: "scroll" }, el("table", null,
      el("thead", null, el("tr", null, ...heads.map((h) => el("th", { text: h })))),
      el("tbody", null, ...rows)));

    $("main").replaceChildren(el("div", { style: "display:flex;flex-direction:column;gap:12px" },
      el("div", { class: "cards" },
        workerCard(s),
        card("대기 · 출제 중", `${s.queue.pending} · ${s.queue.working}`, s.queue.oldest_pending ? `가장 오래 기다린 요청 ${ago(s.queue.oldest_pending)}` : "밀린 요청 없음"),
        card("최근 24시간 요청", String(t.total), `완료 ${t.done} · 실패 ${t.error} · 다시 출제 ${t.retries}`),
        card("평균 처리 시간", fmtSec(t.avg_run), `대기 ${fmtSec(t.avg_wait)} 뒤 시작`),
        card("사용자", String(u.users), `구글 ${u.google_users} · 게스트 ${u.users - u.google_users}`)),
      el("div", { class: "two" },
        el("section", { class: "box" }, el("h2", null, "최근 14일 요청", el("small", { text: "막대에 올리면 숫자" })), ...dayChart(days),
          tableOf(["날짜", "요청", "완료", "실패"], days.slice().reverse().filter((d) => d.total).map((d) => el("tr", null,
            el("td", { class: "num", text: d.day.slice(5) }), el("td", { class: "num", text: String(d.total) }), el("td", { class: "num", text: String(d.done) }), el("td", { class: "num", text: String(d.error) }))))),
        el("section", { class: "box" }, el("h2", null, "저장 공간", el("small", { text: "무료 플랜 한도" })),
          meter("DB", u.db_bytes, DB_LIMIT),
          meter("파일 저장소", storage, STORAGE_LIMIT),
          el("p", { class: "foot", text: `요청 그림 ${u.request_images.n}개 (${fmtBytes(u.request_images.bytes)}) · 시험지 그림 ${u.exam_figures.n}개 (${fmtBytes(u.exam_figures.bytes)})` }),
          el("p", { class: "foot", text: `요청 ${u.requests}개 · 시험지 ${u.exams}개. 끝난 지 14일 지난 요청의 자료와 안 쓰는 그림은 NAS가 하루 한 번 지워요.` }),
          el("h2", null, "요청 한도", el("small", { text: "Table Editor > limits 에서 수정" })),
          el("p", { class: "foot", style: "font-size:13px;color:var(--ink)", text: s.limits ? `1인 하루 ${s.limits.per_ip_daily} · 동시 ${s.limits.per_ip_open} · 전체 하루 ${s.limits.total_daily}` : "–" }),
          el("h2", null, "오늘 많이 쓴 사람", el("small", { text: "IP 일부 가림" })),
          (s.top_ips || []).length ? tableOf(["IP", "요청"], s.top_ips.map((r) => el("tr", null, el("td", { class: "num", text: r.ip }), el("td", { class: "num", text: String(r.n) })))) : el("p", { class: "foot", text: "오늘 요청 없음" }))),
      reportsBox(reports || []),
      autoBox(autos || []),
      el("section", { class: "box" }, el("h2", null, "최근 실패", el("small", { text: "최근 15개" })),
        failures.length ? tableOf(["시각", "과목 / 파일", "원인"], failures.map((f) => el("tr", null,
          el("td", { class: "num", text: when(f.created_at) }),
          el("td", { text: f.subject || (f.files || []).join(", ") || "–" }),
          el("td", null, el("div", { text: f.error || "–" }), f.fail_detail ? el("div", { class: "detail", text: f.fail_detail }) : null)))) : el("p", { class: "foot", text: "실패한 요청이 없어요." }))));
    $("updated").textContent = "업데이트 " + new Date(s.now).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function message(text, button) {
    $("main").replaceChildren(el("div", { class: "msg" }, el("p", { text }), button || null));
    $("updated").textContent = "";
  }

  async function load() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session || session.user.is_anonymous) {
      message("관리자 구글 계정으로 로그인해야 볼 수 있어요.",
        el("button", { type: "button", class: "btn google", onclick: () => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } }) },
          el("span", { class: "g", text: "G" }), "구글로 로그인"));
      return;
    }
    const { data, error } = await sb.rpc("admin_stats");
    if (error) {
      message(/not_admin/.test(error.message) ? `${session.user.email} 계정은 관리자로 등록돼 있지 않아요.` : "불러오지 못했어요: " + error.message);
      return;
    }
    const [rep, auto] = await Promise.all([sb.rpc("admin_reports"), sb.rpc("admin_auto_reports")]);
    render(data, rep.error ? [] : rep.data, auto.error ? [] : auto.data);
  }

  $("reload").addEventListener("click", load);
  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_IN") setTimeout(load, 0); });
  load();
  setInterval(() => { if (!document.hidden) load(); }, 60000);
})();
