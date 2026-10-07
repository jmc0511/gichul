// 개인정보처리방침 페이지의 '계정 삭제' 버튼
(async function () {
  const box = document.getElementById("deleteBox"), st = document.getElementById("deleteState");
  const cfg = window.GICHUL_CONFIG || {};
  if (!window.supabase || !cfg.SUPABASE_URL) { st.textContent = "지금은 확인할 수 없어요. 이메일로 요청해 주세요."; return; }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { st.textContent = "로그인하지 않은 상태예요. 로그인하지 않았다면 서버에 저장된 계정이 없어요. 브라우저에 남은 기록은 사이트 데이터 지우기로 지울 수 있어요."; return; }
  const who = session.user.is_anonymous ? "게스트 계정" : (session.user.email || "내 계정");
  st.textContent = `지금 로그인한 계정: ${who}`;
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn danger"; btn.textContent = "계정 삭제";
  let armed = null;
  btn.addEventListener("click", async () => {
    if (!armed) {
      btn.textContent = "정말 모두 지울까요? 한 번 더 누르면 삭제"; btn.classList.add("armed");
      armed = setTimeout(() => { armed = null; btn.textContent = "계정 삭제"; btn.classList.remove("armed"); }, 5000);
      return;
    }
    clearTimeout(armed); btn.disabled = true; btn.textContent = "지우는 중…";
    const { data, error } = await sb.rpc("delete_my_account");
    if (error || !data) { btn.disabled = false; btn.textContent = "계정 삭제"; btn.classList.remove("armed"); armed = null; st.textContent = "지우지 못했어요. 잠시 후 다시 시도하거나 이메일로 요청해 주세요."; return; }
    await sb.auth.signOut().catch(() => {});
    try { Object.keys(localStorage).filter((k) => k.startsWith("gichul.") || k.startsWith("sb-")).forEach((k) => localStorage.removeItem(k)); } catch (e) {}
    try { indexedDB.deleteDatabase("gichuri-library"); } catch (e) {}
    const done = document.createElement("p");
    const b = document.createElement("b"); b.textContent = "계정과 기록을 모두 지웠어요.";
    done.append(b, " 이용해 주셔서 고마워요.");
    box.replaceChildren(done);
  });
  box.append(btn);
})();
