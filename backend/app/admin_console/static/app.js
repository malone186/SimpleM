// [한글 주석: 브루노트 관리자 데스크톱 콘솔 로직 - 상단 필터 탭 통합 버전]
document.addEventListener('DOMContentLoaded', () => {
  // Lucide 아이콘 로드
  if (window.lucide) {
    lucide.createIcons();
  }

  // ━━━ 관리자 로그인 게이트 (A방안: 로그인 → 토큰 발급 → 모든 관리자 API에 자동 첨부) ━━━
  const ADMIN_TOKEN_KEY = 'simplem_admin_token';

  // 백엔드 주소 — 이 페이지는 FastAPI(/console)가 직접 서빙하므로 기본은 같은 origin의
  // 상대 경로다 (Jinja 템플릿이 window.__ADMIN_API_BASE__로 주입). 로컬 uvicorn이든
  // Cloud Run이든 하드코딩 없이 동작하고, 예전처럼 다른 백엔드로 붙이려면:
  //   localStorage.setItem('simplem_admin_api', 'http://localhost:8000/api/v1')
  // 되돌리려면: localStorage.removeItem('simplem_admin_api')
  const DEFAULT_API = `${window.__ADMIN_API_BASE__ ?? ''}/api/v1`;
  const ADMIN_API = localStorage.getItem('simplem_admin_api') || DEFAULT_API;
  const getAdminToken = () => localStorage.getItem(ADMIN_TOKEN_KEY) || '';

  // 원본 fetch를 감싸 /admin, /auth/users 호출에 Authorization 헤더를 자동으로 실어 준다 (login 제외)
  const _origFetch = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    try {
      const u = typeof url === 'string' ? url : (url && url.url) || '';
      if (/\/api\/v1\/(admin|auth\/users|chatbot\/agents)/.test(u) && !/\/admin\/login/.test(u)) {
        const t = getAdminToken();
        if (t) opts = Object.assign({}, opts, { headers: Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + t }) });
      }
    } catch (e) {}
    return _origFetch(url, opts).then((res) => {
      try {
        const u = typeof url === 'string' ? url : (url && url.url) || '';
        if ((res.status === 401 || res.status === 403) && /\/api\/v1\/(admin|auth\/users|chatbot\/agents)/.test(u) && !/\/admin\/login/.test(u)) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          showAdminLogin('세션이 만료되었습니다. 다시 로그인해 주세요.');
        }
      } catch (e) {}
      return res;
    });
  };

  // 실패한 응답을 사람이 읽을 수 있는 한 줄로 바꾼다.
  // FastAPI는 422일 때 detail을 객체 배열로 주는데, 그대로 문자열에 넣으면
  // 화면에 '[object Object]'만 뜨고 뭐가 잘못됐는지 알 수 없다.
  async function describeError(res) {
    let detail = '';
    try {
      const body = await res.json();
      if (typeof body.detail === 'string') {
        detail = body.detail;
      } else if (Array.isArray(body.detail)) {
        detail = body.detail.map((d) => d.msg || JSON.stringify(d)).join(', ');
      }
    } catch (e) {
      /* 본문이 JSON이 아니면 상태 코드만 쓴다 */
    }
    return detail ? `HTTP ${res.status} · ${detail}` : `HTTP ${res.status}`;
  }

  function showAdminLogin(message) {
    if (document.getElementById('admin-login-overlay')) {
      if (message) { const e = document.getElementById('admin-login-err'); if (e) e.textContent = message; }
      return;
    }
    const ov = document.createElement('div');
    ov.id = 'admin-login-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#2b2320;display:flex;align-items:center;justify-content:center;';
    ov.innerHTML = `
      <form id="admin-login-form" style="background:#fff;border-radius:16px;padding:32px;width:340px;max-width:90%;box-shadow:0 10px 40px rgba(0,0,0,.3);font-family:Pretendard,sans-serif;">
        <div style="font-size:18px;font-weight:800;color:#3a2e28;margin-bottom:4px;">브루노트 관리자 콘솔</div>
        <div style="font-size:12px;color:#8a7a71;margin-bottom:18px;">관리자 계정으로 로그인하세요.</div>
        <input id="admin-login-email" type="email" placeholder="관리자 이메일" value="admin@simplem.com" autocomplete="username" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #e0d8d2;border-radius:10px;margin-bottom:10px;font-size:13px;" />
        <input id="admin-login-pw" type="password" placeholder="비밀번호" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #e0d8d2;border-radius:10px;margin-bottom:6px;font-size:13px;" />
        <div id="admin-login-err" style="color:#c62828;font-size:11.5px;min-height:16px;margin-bottom:8px;">${message || ''}</div>
        <button type="submit" style="width:100%;padding:12px;border:none;border-radius:10px;background:#6b4a32;color:#fff;font-weight:700;font-size:14px;cursor:pointer;">로그인</button>
      </form>`;
    document.body.appendChild(ov);
    document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('admin-login-email').value.trim();
      const password = document.getElementById('admin-login-pw').value;
      const errEl = document.getElementById('admin-login-err');
      errEl.textContent = '로그인 중...';
      try {
        const res = await _origFetch(`${ADMIN_API}/admin/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) {
          errEl.textContent = res.status === 401 ? '이메일 또는 비밀번호가 올바르지 않습니다.' : ('로그인 실패 (' + res.status + ')');
          return;
        }
        const data = await res.json();
        localStorage.setItem(ADMIN_TOKEN_KEY, data.access_token);
        location.reload();
      } catch (err) {
        errEl.textContent = '서버에 연결할 수 없습니다.';
      }
    });
  }

  // 로그아웃 버튼 → 토큰 삭제 후 로그인 화면
  const _logoutBtn = document.getElementById('logout-btn');
  if (_logoutBtn) _logoutBtn.addEventListener('click', () => { localStorage.removeItem(ADMIN_TOKEN_KEY); location.reload(); });

  // 토큰이 없으면 로그인 화면만 띄우고 나머지 대시보드 초기화는 중단 (로그인 성공 시 reload로 재실행)
  if (!getAdminToken()) { showAdminLogin(); return; }

  // 로그인한 관리자 계정과 접속 중인 백엔드를 화면에 반영한다 (둘 다 예전엔 하드코딩)
  (function reflectSession() {
    try {
      const email = JSON.parse(atob(getAdminToken().split('.')[1] || '')).sub || '';
      const emailEl = document.getElementById('admin-email');
      const avatarEl = document.getElementById('admin-avatar');
      if (emailEl && email) emailEl.textContent = email;
      if (avatarEl && email) avatarEl.textContent = email.charAt(0).toUpperCase();
    } catch (e) {
      /* 토큰 모양이 예상과 다르면 기본 표시 그대로 둔다 */
    }
    // (삭제됨) Swagger·백엔드 루트 링크 주소 주입 — 링크 자체를 없앴다(개발자용)
  })();

  // 비밀번호 변경 — 백엔드에 POST /admin/password가 있는데 화면에 들어올 입구가 없어서,
  // 관리자가 콘솔에서 자기 비밀번호를 바꿀 방법이 아예 없었다.
  const _changePwBtn = document.getElementById('change-pw-btn');
  if (_changePwBtn) _changePwBtn.addEventListener('click', showPasswordChange);

  function showPasswordChange() {
    if (document.getElementById('admin-pw-overlay')) return;
    const ov = document.createElement('div');
    ov.id = 'admin-pw-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(43,35,32,.6);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML = `
      <form id="admin-pw-form" style="background:#fff;border-radius:16px;padding:28px;width:340px;max-width:90%;box-shadow:0 10px 40px rgba(0,0,0,.3);font-family:Pretendard,sans-serif;">
        <div style="font-size:16px;font-weight:800;color:#3a2e28;margin-bottom:4px;">관리자 비밀번호 변경</div>
        <div style="font-size:12px;color:#8a7a71;margin-bottom:16px;">공유 DB에 저장되므로 모든 컴퓨터에 즉시 적용됩니다.</div>
        <input id="admin-pw-cur" type="password" placeholder="현재 비밀번호" autocomplete="current-password"
          style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #e0d8d2;border-radius:10px;margin-bottom:10px;font-size:13px;" />
        <input id="admin-pw-new" type="password" placeholder="새 비밀번호 (8자 이상)" autocomplete="new-password"
          style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #e0d8d2;border-radius:10px;margin-bottom:10px;font-size:13px;" />
        <input id="admin-pw-new2" type="password" placeholder="새 비밀번호 확인" autocomplete="new-password"
          style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #e0d8d2;border-radius:10px;margin-bottom:6px;font-size:13px;" />
        <div id="admin-pw-err" style="color:#c62828;font-size:11.5px;min-height:16px;margin-bottom:8px;"></div>
        <div style="display:flex;gap:8px;">
          <button type="button" id="admin-pw-cancel" style="flex:1;padding:11px;border:1px solid #e0d8d2;border-radius:10px;background:#fff;color:#6b5b52;font-weight:700;font-size:13px;cursor:pointer;">취소</button>
          <button type="submit" id="admin-pw-submit" style="flex:1;padding:11px;border:none;border-radius:10px;background:#6b4a32;color:#fff;font-weight:700;font-size:13px;cursor:pointer;">변경</button>
        </div>
      </form>`;
    document.body.appendChild(ov);

    const close = () => ov.remove();
    document.getElementById('admin-pw-cancel').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });

    document.getElementById('admin-pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const cur = document.getElementById('admin-pw-cur').value;
      const nw = document.getElementById('admin-pw-new').value;
      const nw2 = document.getElementById('admin-pw-new2').value;
      const err = document.getElementById('admin-pw-err');

      // 서버도 8자 이상을 요구한다 — 여기서 먼저 걸러 왕복을 아낀다
      if (nw.length < 8) { err.textContent = '새 비밀번호는 8자 이상이어야 합니다.'; return; }
      if (nw !== nw2) { err.textContent = '새 비밀번호가 서로 다릅니다.'; return; }

      const btn = document.getElementById('admin-pw-submit');
      btn.disabled = true;
      err.textContent = '변경 중...';
      try {
        const res = await fetch(`${ADMIN_API}/admin/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current_password: cur, new_password: nw }),
        });
        if (!res.ok) throw new Error(await describeError(res));
        close();
        alert('비밀번호가 변경되었습니다. 보안을 위해 다시 로그인해 주세요.');
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        location.reload();
      } catch (e2) {
        err.textContent = String(e2.message || e2);
        btn.disabled = false;
      }
    });
  }

  // 1. 탭 전환 기능 (2개 간소화: 대시보드 / 회원 관리)
  const navItems = document.querySelectorAll('.nav-item');
  const tabContents = document.querySelectorAll('.tab-content');
  const pageTitle = document.getElementById('page-title');

  const titleMap = {
    dashboard: '대시보드 개요',
    agents: 'AI 에이전트 오케스트레이션',
    users: '전체 사장님 회원 관리',
    cs: '사장님 1:1 CS 및 문의 관리',
    notifications: '사장님 공지 & 알림 발송',
  };

  // 🩺 [한글 주석: 각 개별 항목 수동 헬스체크 재점검 기능]
  window.checkSingleHealth = async function (type) {
    const card = document.getElementById(`status-${type}`);
    if (!card) return;
    const btn = card.querySelector('.health-refresh-btn');
    if (btn) btn.classList.add('spinning');
    // 셋 다 같은 /health 응답에서 나오므로 한 번 읽어 해당 카드만 갱신한다
    const only = { api: null, db: null, ocr: null };
    only[type] = card;
    await applyHealth(only);
    if (btn) btn.classList.remove('spinning');
  };

  window.switchTab = function (targetTab) {
    navItems.forEach((b) => b.classList.remove('active'));
    tabContents.forEach((c) => c.classList.remove('active'));

    const activeNav = document.querySelector(`.nav-item[data-tab="${targetTab}"]`);
    if (activeNav) activeNav.classList.add('active');

    const targetElement = document.getElementById(`tab-${targetTab}`);
    if (targetElement) targetElement.classList.add('active');

    if (pageTitle && titleMap[targetTab]) {
      pageTitle.textContent = titleMap[targetTab];
    }

    // [한글 주석: AI 에이전트 탭 진입 시 최신 편성 자동 조회, CS 탭 진입 시 최신 문의 자동 동기화]
    if (targetTab === 'agents') {
      loadAgents();
    } else if (targetTab === 'cs') {
      loadCSList();
    }
  };

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const targetTab = item.getAttribute('data-tab');
      switchTab(targetTab);
    });
  });

  // 2. 백엔드 실시간 헬스 체크 — API·DB·OCR을 /health 한 번으로 확인한다.
  //    주소는 ADMIN_API를 따라간다 (예전엔 배포 주소가 박혀 있어, 로컬 백엔드로 돌려도
  //    상태 카드만 배포 서버를 가리켰다).
  const HEALTH_URL = () => `${API_BASE.replace('/api/v1', '')}/health`;

  function paintStatus(card, state, label, name) {
    // state: 'ok' | 'fail' | 'unknown'
    if (!card) return;
    const tone = state === 'ok' ? 'green' : state === 'fail' ? 'red' : 'amber';
    card.querySelector('.status-indicator').className = `status-indicator ${tone}`;
    const badge = card.querySelector('.status-badge');
    badge.className = `status-badge ${tone}-bg${state === 'fail' ? ' pulse' : ''}`;
    badge.textContent = label;
    // 항목 이름은 서버가 알려준 실제 구성으로 바꾼다 (예: 'Neon PostgreSQL · ap-southeast-1')
    if (name) {
      const nameEl = card.querySelector('.status-label');
      if (nameEl) nameEl.textContent = name;
    }
  }

  // /health의 db 정보를 화면 라벨 문자열로 — 어느 DB에 붙었는지 한눈에 보이게
  function dbLabel(db) {
    if (!db || !db.provider) return '';
    const bits = [db.provider];
    if (db.region) bits.push(db.region);
    if (db.database) bits.push(db.database);
    return bits.join(' · ');
  }

  async function readHealth() {
    const res = await fetch(HEALTH_URL());
    const body = res.ok ? await res.json() : null;
    return { res, components: body && body.components };
  }

  async function applyHealth(cards) {
    try {
      const { res, components: c } = await readHealth();
      paintStatus(cards.api, res.ok ? 'ok' : 'fail', res.ok ? '정상 작동 중' : `서버 오류 (${res.status})`);

      if (!c) {
        // 구버전 백엔드는 {"status":"ok"}만 준다 — 구성요소를 알 수 없다.
        // 이때 '정상'이나 '대기'라고 단정하면 그게 곧 오보다. 모른다고 말한다.
        // (배포본이 아직 옛 버전이면 여기로 온다 — 백엔드를 재배포하면 초록으로 바뀐다.)
        const msg = res.ok ? '구버전 서버 — 확인 불가' : '확인 불가';
        paintStatus(cards.db, 'unknown', msg);
        paintStatus(cards.ocr, 'unknown', msg);
        return;
      }
      paintStatus(
        cards.db,
        c.db.ok ? 'ok' : 'fail',
        c.db.ok ? '정상 연결됨' : '연결 실패',
        dbLabel(c.db) || '데이터베이스',
      );
      paintStatus(cards.ocr, c.ocr.ok ? 'ok' : 'fail', c.ocr.ok ? `정상 · ${c.ocr.detail}` : c.ocr.detail || 'API 키 없음');
      markPanelLive('health-live-tag');
    } catch (err) {
      paintStatus(cards.api, 'fail', '서버 오프라인');
      paintStatus(cards.db, 'unknown', '확인 불가');
      paintStatus(cards.ocr, 'unknown', '확인 불가');
      // 서버가 죽었는데 'LIVE'가 초록으로 붙어 있으면 그 자체가 오보다
      markPanelOffline('health-live-tag');
    }
  }

  const healthCards = () => ({
    api: document.getElementById('status-api'),
    db: document.getElementById('status-db'),
    ocr: document.getElementById('status-ocr'),
  });

  async function checkBackendHealth() {
    await applyHealth(healthCards());
  }

  // 3. 실시간 백엔드 API 연동 베이스 URL
  const API_BASE = ADMIN_API; // 주소는 ADMIN_API 한 곳에서만 정한다

  // [한글 주석: 백엔드 API 호출을 통해 채워질 실시간 데이터 보관함]
  let mockUsers = [];
  let mockNotifHistory = [];

  let selectedUser = null;
  // (삭제됨) currentFilter — 등급 필터(전체/프리미엄/일반)는 유료 플랜과 함께 사라졌다.
  // 회원 목록은 검색어로만 좁힌다.

  // 4. [한글 주석: 메인 대시보드 최근 가입 타임라인 피드 - DB 최신순 가입 사장님 노출]
  const recentFeedContainer = document.getElementById('recent-users-feed');

  function renderTimelineFeed(highlightFirst = false) {
    if (!recentFeedContainer || mockUsers.length === 0) {
      if (recentFeedContainer) recentFeedContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #8A7A71;">최근 가입한 회원이 없습니다.</div>';
      return;
    }

    // 가입일이 최신인 순서대로 정렬하여 상위 3개 점포를 보여줍니다.
    const sorted = [...mockUsers].sort((a, b) => new Date(b.joined) - new Date(a.joined));
    const currentList = sorted.slice(0, 3);

    recentFeedContainer.innerHTML = currentList
      .map((u, index) => {
        const isNew = highlightFirst && index === 0;
        // 'NEW'는 최근 7일 안에 가입한 회원에게만 — 예전엔 세 장 모두에 무조건 붙어서
        // 반년 전에 가입한 매장에도 반짝이가 달렸다
        const joinedAt = new Date(u.joined);
        const isRecent = !isNaN(joinedAt) && (Date.now() - joinedAt.getTime()) < 7 * 24 * 60 * 60 * 1000;
        return `
        <div class="feed-card ${isNew ? 'newly-added' : 'feed-slide-down'}" onclick="openUserDrawer(${u.id})">
          <div class="feed-avatar-box">
            <div class="feed-avatar">${u.store.charAt(0)}</div>
            ${isRecent ? '<span class="new-sparkle-tag">NEW</span>' : ''}
          </div>
          <div class="feed-content">
            <div class="feed-top-row">
              <span class="feed-store-title">${u.store}</span>
              <span class="feed-time-text">${isNew ? '방금 가입' : u.joined}</span>
            </div>
            <div class="feed-owner-text">${u.name} 사장님 (${u.email})</div>
            <div class="feed-meta-row">
              <span class="status-badge ${u.status === '활성' ? 'green-bg' : 'brown-bg'}">${u.status}</span>
            </div>
          </div>
        </div>
      `;
      })
      .join('');
  }

  // 5. [회원 관리] 탭 통합 사장님 테이블 렌더링
  const userTableBody = document.getElementById('user-table-body');
  let currentUserFilter = 'all';   // all | 활성 | 대기 | 정지

  // 검색·상태 필터를 통과한 목록 — 표와 CSV 내보내기가 같은 결과를 쓴다
  function filteredUsers() {
    let items = mockUsers;
    if (currentUserFilter !== 'all') {
      items = items.filter((u) => (u.status || '활성') === currentUserFilter);
    }
    const q = document.getElementById('user-search-input')?.value.toLowerCase().trim();
    if (q) {
      items = items.filter(
        (u) => u.name.toLowerCase().includes(q) || u.store.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
      );
    }
    return items;
  }

  function renderUserTable() {
    if (!userTableBody) return;

    const items = filteredUsers();
    const countBadge = document.getElementById('user-count-badge');
    if (countBadge) {
      countBadge.textContent = items.length === mockUsers.length
        ? `${mockUsers.length}명`
        : `${items.length} / ${mockUsers.length}명`;
    }

    if (items.length === 0) {
      // 열 개수(7)와 맞춰야 안내 문구가 표 전체 폭에 걸린다 — 구독 유형이 빠지고 보유 코인이 들어왔다
      const msg = mockUsers.length === 0 ? '가입된 사장님 회원 데이터가 없습니다.' : '조건에 맞는 회원이 없습니다.';
      userTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: #8A7A71;">${msg}</td></tr>`;
      return;
    }

    userTableBody.innerHTML = items
      .map(
        (u) => `
      <tr class="clickable-row" onclick="openUserDrawer(${u.id})">
        <td>#${u.id}</td>
        <td><strong>${u.name}</strong></td>
        <td>${u.store}</td>
        <td>${u.email}</td>
        <td><span class="status-badge ${u.status === '활성' ? 'green-bg' : u.status === '정지' ? 'cancel' : 'brown-bg'}">${u.status}</span></td>
        <td><strong>${(u.coins ?? 0).toLocaleString()}</strong> 코인</td>
        <td><button class="link-btn" onclick="event.stopPropagation(); openUserDrawer(${u.id})">상세보기</button></td>
      </tr>
    `
      )
      .join('');
  }

  // (삭제됨) 상단 등급 필터 탭 — 버튼 자체가 HTML에서 빠졌다 (유료 플랜 폐지)

  // 계정 상태 필터
  document.querySelectorAll('.user-filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.user-filter-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      currentUserFilter = pill.dataset.userFilter;
      renderUserTable();
    });
  });

  // CSV 내보내기 — 화면에 보이는 목록 그대로. 엑셀이 한글을 깨뜨리지 않게 BOM을 붙인다.
  const btnExportUsers = document.getElementById('btn-export-users');
  if (btnExportUsers) {
    btnExportUsers.addEventListener('click', () => {
      const items = filteredUsers();
      if (items.length === 0) {
        alert('내보낼 회원이 없습니다.');
        return;
      }
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['ID', '사장님 이름', '매장명', '이메일', '계정 상태', '가입 일자', 'OCR 건수', '재고 품목', '생성 서류', '보유 코인', '관리자 메모'];
      const rows = items.map((u) => [
        u.id, u.name, u.store, u.email, u.status, u.joined,
        u.ocrCount ?? 0, u.stockCount ?? 0, u.docCount ?? 0, u.coins ?? 0, u.memo || '',
      ].map(cell).join(','));
      const csv = '﻿' + [header.map(cell).join(','), ...rows].join('\r\n');

      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a');
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      a.href = url;
      a.download = `브루노트_회원목록_${stamp}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // 검색어 입력 이벤트
  const searchInput = document.getElementById('user-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderUserTable();
    });
  }

  // 6. 우측 슬라이드오버 Drawer 컨트롤러
  const drawerOverlay = document.getElementById('drawer-overlay');
  const drawerCloseBtn = document.getElementById('drawer-close-btn');

  window.openUserDrawer = function (userId) {
    const user = mockUsers.find((u) => u.id === userId);
    if (!user) return;
    selectedUser = user;

    // 데이터 채우기
    document.getElementById('drawer-user-id').textContent = `#${user.id}`;
    document.getElementById('drawer-store-name').textContent = user.store;
    document.getElementById('drawer-avatar').textContent = (user.store || user.name || '?').trim().charAt(0);
    document.getElementById('drawer-user-name').textContent = user.name;
    document.getElementById('drawer-user-email').textContent = user.email;
    document.getElementById('drawer-user-joined').textContent = user.joined;
    paintDrawerStatusChip(user.status);

    // 계정 상태 드롭다운
    const statusSelect = document.getElementById('drawer-user-status-select');
    if (statusSelect) statusSelect.value = user.status;

    // (삭제됨) 구독 정보 — 유료 플랜 폐지

    // 실시간 사용 통계 — 백엔드가 센 실제 건수 (예전엔 화면에 14건·28개가 박혀 있었다)
    document.getElementById('drawer-stat-ocr').innerHTML = `${user.ocrCount ?? 0}<span class="stat-unit">건</span>`;
    document.getElementById('drawer-stat-stocks').innerHTML = `${user.stockCount ?? 0}<span class="stat-unit">개</span>`;
    document.getElementById('drawer-stat-docs').innerHTML = `${user.docCount ?? 0}<span class="stat-unit">건</span>`;

    // 관리자 메모 — DB(admin_user_notes)에 저장된 값
    document.getElementById('drawer-user-memo').value = user.memo || '';

    // 코인 — 목록에 실린 잔액을 먼저 보여 주고(깜빡임 방지), 내역은 열면서 새로 읽는다
    paintCoinBalance({ balance: user.coins ?? 0, total_earned: null });
    resetCoinInputs();
    loadUserCoins(user.id);

    if (window.lucide) lucide.createIcons();

    drawerOverlay.classList.add('active');
  };

  // 6-1. 코인 지급 — 상점 재화를 관리자가 직접 넣거나 회수한다.
  //      적립의 정상 경로는 '할 일 완료'다. 여기는 CS 보상·이벤트·오지급 회수용 예외 창구라
  //      내역에 '관리자 지급/회수'로 남아 사장님 상점 화면에서도 출처가 보인다.
  // 헤더의 상태 배지 — 목록의 배지와 같은 색 규칙을 쓴다(활성=초록, 정지=빨강, 대기=갈색)
  function paintDrawerStatusChip(status) {
    const chip = document.getElementById('drawer-status-chip');
    if (!chip) return;
    const tone = status === '활성' ? 'green-bg' : status === '정지' ? 'cancel' : 'brown-bg';
    chip.className = `status-badge ${tone}`;
    chip.textContent = status;
  }

  let coinMode = 'grant';   // grant(지급) | revoke(회수)
  let coinBalance = 0;      // 미리보기 계산에 쓰는 현재 잔액

  function paintCoinBalance(wallet) {
    const balEl = document.getElementById('drawer-coin-balance');
    const earnEl = document.getElementById('drawer-coin-earned');
    coinBalance = Number(wallet.balance || 0);
    if (balEl) {
      balEl.innerHTML = `${coinBalance.toLocaleString()}<span class="stat-unit">코인</span>`;
    }
    if (earnEl) {
      earnEl.textContent = wallet.total_earned === null || wallet.total_earned === undefined
        ? '확인 중…'
        : `${Number(wallet.total_earned).toLocaleString()}코인`;
    }
    updateCoinPreview();
  }

  // 누르기 전에 결과를 보여 준다 — 잘못 지급하면 되돌리려고 다시 회수해야 하니
  // '지급 후 잔액'과 '잔액보다 많은 회수'를 버튼 위에서 미리 알려 준다.
  function updateCoinPreview() {
    const preview = document.getElementById('coin-preview');
    const btn = document.getElementById('btn-grant-coin');
    if (!preview || !btn) return;

    const raw = parseInt(document.getElementById('coin-amount-input')?.value, 10);
    const amount = Number.isFinite(raw) ? Math.abs(raw) : 0;
    const verb = coinMode === 'grant' ? '지급' : '회수';

    // 칩 선택 표시 — 입력값과 같은 금액만 켠다
    document.querySelectorAll('.coin-chip').forEach((chip) => {
      chip.classList.toggle('active', amount > 0 && Number(chip.dataset.coin) === amount);
    });

    if (!amount) {
      preview.className = 'coin-preview';
      preview.textContent = `코인 수를 입력하면 ${verb} 후 잔액을 미리 보여 드려요.`;
      btn.disabled = false;
      return;
    }
    if (coinMode === 'revoke' && amount > coinBalance) {
      preview.className = 'coin-preview warn';
      preview.textContent = `보유 코인(${coinBalance.toLocaleString()}개)보다 많이 회수할 수 없어요.`;
      btn.disabled = true;
      return;
    }
    const next = coinMode === 'grant' ? coinBalance + amount : coinBalance - amount;
    preview.className = 'coin-preview';
    preview.textContent = `${verb} 후 잔액 ${next.toLocaleString()}코인 (${coinMode === 'grant' ? '+' : '-'}${amount.toLocaleString()})`;
    btn.disabled = false;
  }

  function setCoinMode(mode) {
    coinMode = mode;
    document.querySelectorAll('.coin-mode-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    });
    const btn = document.getElementById('btn-grant-coin');
    const label = document.getElementById('coin-grant-btn-label');
    if (btn) btn.classList.toggle('revoke', mode === 'revoke');
    if (label) label.textContent = mode === 'grant' ? '코인 지급하기' : '코인 회수하기';
    updateCoinPreview();
  }

  function paintCoinHistory(history) {
    const box = document.getElementById('drawer-coin-history');
    const countEl = document.getElementById('coin-history-count');
    if (!box) return;
    if (countEl) countEl.textContent = history && history.length ? `최근 ${history.length}건` : '';
    if (!history || history.length === 0) {
      box.innerHTML = '<div class="coin-history-empty">아직 코인 내역이 없습니다.</div>';
      return;
    }
    box.innerHTML = history
      .map((h) => {
        const plus = h.delta > 0;
        const when = h.created_at ? new Date(h.created_at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
        const label = h.memo ? `${h.reason_label} · ${h.memo}` : h.reason_label;
        return `
        <div class="coin-history-row">
          <div class="coin-history-main">
            <span class="coin-history-reason">${label}</span>
            <span class="coin-history-date">${when}</span>
          </div>
          <span class="coin-history-delta ${plus ? 'plus' : 'minus'}">${plus ? '+' : ''}${Number(h.delta).toLocaleString()}</span>
        </div>`;
      })
      .join('');
  }

  function resetCoinInputs() {
    const amount = document.getElementById('coin-amount-input');
    const memo = document.getElementById('coin-memo-input');
    if (amount) amount.value = '';
    if (memo) memo.value = '';
    setCoinMode('grant');  // 회원을 새로 열 때는 늘 '지급'에서 시작한다
  }

  async function loadUserCoins(userId) {
    const box = document.getElementById('drawer-coin-history');
    if (box) box.innerHTML = '<div class="coin-history-empty">불러오는 중…</div>';
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/coins`);
      if (!res.ok) throw new Error(await describeError(res));
      const wallet = await res.json();
      // 응답이 늦게 와도 그 사이 다른 회원을 열었으면 덮어쓰지 않는다
      if (!selectedUser || selectedUser.id !== userId) return;
      selectedUser.coins = wallet.balance;
      paintCoinBalance(wallet);
      paintCoinHistory(wallet.history);
    } catch (err) {
      console.error('코인 조회 실패:', err);
      if (box) box.innerHTML = `<div class="coin-history-empty">코인 내역을 불러오지 못했습니다 (${err.message}).</div>`;
    }
  }

  document.querySelectorAll('.coin-mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => setCoinMode(tab.dataset.mode));
  });

  document.querySelectorAll('.coin-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const input = document.getElementById('coin-amount-input');
      if (!input) return;
      // 같은 칩을 다시 누르면 해제 — 잘못 고른 금액을 지우려고 입력칸을 비울 필요가 없다
      input.value = Number(input.value) === Number(chip.dataset.coin) ? '' : chip.dataset.coin;
      updateCoinPreview();
    });
  });

  const coinAmountInput = document.getElementById('coin-amount-input');
  if (coinAmountInput) coinAmountInput.addEventListener('input', updateCoinPreview);

  const btnGrantCoin = document.getElementById('btn-grant-coin');
  if (btnGrantCoin) {
    btnGrantCoin.addEventListener('click', async () => {
      if (!selectedUser) return;
      const amountInput = document.getElementById('coin-amount-input');
      const memoInput = document.getElementById('coin-memo-input');
      const typed = parseInt(amountInput?.value, 10);
      const action = coinMode === 'grant' ? '지급' : '회수';

      if (!Number.isFinite(typed) || typed === 0) {
        alert(`${action}할 코인 수를 입력해 주세요.`);
        amountInput?.focus();
        return;
      }
      // 부호는 탭이 정한다 — 사용자가 음수를 쳐도 회수 탭에서 이중으로 뒤집히지 않게 절댓값을 쓴다
      const amount = coinMode === 'grant' ? Math.abs(typed) : -Math.abs(typed);
      const target = `'${selectedUser.store}' (${selectedUser.name} 사장님) 계정${coinMode === 'grant' ? '에' : '에서'}`;
      if (!confirm(`${target} ${Math.abs(amount).toLocaleString()}코인을 ${action}합니다.\n계속할까요?`)) return;

      btnGrantCoin.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/admin/users/${selectedUser.id}/coins`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount, memo: memoInput?.value || '' }),
        });
        if (!res.ok) throw new Error(await describeError(res));
        const wallet = await res.json();
        selectedUser.coins = wallet.balance;
        paintCoinBalance(wallet);
        paintCoinHistory(wallet.history);
        resetCoinInputs();
        renderUserTable();  // 목록의 '보유 코인' 열도 즉시 맞춘다
        alert(`${Math.abs(amount).toLocaleString()}코인을 ${action}했습니다. 현재 잔액 ${Number(wallet.balance).toLocaleString()}코인.`);
      } catch (err) {
        console.error('코인 지급 실패:', err);
        alert(`코인을 ${action}하지 못했습니다 — ${err.message}`);
      } finally {
        // 잠금 해제는 미리보기에 맡긴다 — 잔액을 넘는 회수가 입력된 채로 다시 열리면 안 된다
        btnGrantCoin.disabled = false;
        updateCoinPreview();
      }
    });
  }

  function closeUserDrawer() {
    drawerOverlay.classList.remove('active');
    selectedUser = null;
  }

  if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', closeUserDrawer);
  if (drawerOverlay) {
    drawerOverlay.addEventListener('click', (e) => {
      if (e.target === drawerOverlay) closeUserDrawer();
    });
  }

  // 7. 계정 상태 변경 이벤트 — DB(admin_user_notes)에 저장한다.
  //    예전엔 화면의 값만 바꾸고 "가상 업데이트되었습니다"라고 알린 뒤, 새로고침하면
  //    원래대로 돌아왔다. 저장에 실패하면 드롭다운을 원래 값으로 되돌린다.
  async function saveUserStatus(nextStatus) {
    if (!selectedUser) return;
    const prev = selectedUser.status;
    try {
      const res = await fetch(`${API_BASE}/admin/users/${selectedUser.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      selectedUser.status = nextStatus;
      paintDrawerStatusChip(nextStatus);
      renderUserTable();
      renderTimelineFeed();
      alert(`${selectedUser.name} 사장님의 계정 상태를 '${nextStatus}'(으)로 저장했습니다.`);
    } catch (err) {
      console.error('계정 상태 저장 실패:', err);
      const sel = document.getElementById('drawer-user-status-select');
      if (sel) sel.value = prev;
      alert(`계정 상태를 저장하지 못했습니다 (${err.message}). 변경 전 값으로 되돌렸습니다.`);
    }
  }

  const statusSelect = document.getElementById('drawer-user-status-select');
  if (statusSelect) {
    statusSelect.addEventListener('change', (e) => saveUserStatus(e.target.value));
  }

  // (삭제됨) 8·9. 프리미엄 연장/해지 — 유료 플랜 폐지

  // 10. 메모 저장 이벤트 — DB에 저장한다 (예전엔 브라우저 메모리에만 남아 새로고침하면 사라졌다)
  const btnSaveMemo = document.getElementById('btn-save-memo');
  if (btnSaveMemo) {
    btnSaveMemo.addEventListener('click', async () => {
      if (!selectedUser) return;
      const memoText = document.getElementById('drawer-user-memo').value;
      try {
        const res = await fetch(`${API_BASE}/admin/users/${selectedUser.id}/memo`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memo: memoText }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        selectedUser.memo = memoText;
        alert(`${selectedUser.store} 사장님 관리자 메모를 저장했습니다.`);
      } catch (err) {
        console.error('메모 저장 실패:', err);
        alert(`메모를 저장하지 못했습니다 (${err.message}). 잠시 후 다시 시도해 주세요.`);
      }
    });
  }

  // 11. (삭제됨) 로그아웃 — 진짜 처리는 맨 위(#logout-btn, 토큰 삭제 후 reload)에 있다.
  //     여기 있던 두 번째 리스너는 alert만 띄우고 아무것도 안 하면서 reload와 경쟁했다.

  // 12. [한글 주석: Drawer 회원 가입 즉시 승인 퀵 처리] — 상태 저장과 같은 API를 쓴다
  const btnApproveUser = document.getElementById('btn-approve-user');
  if (btnApproveUser) {
    btnApproveUser.addEventListener('click', async () => {
      if (!selectedUser) return;
      const sel = document.getElementById('drawer-user-status-select');
      if (sel) sel.value = '활성';
      await saveUserStatus('활성');
    });
  }

  // 🩺 [한글 주석: PostgreSQL 사장님 계정 영구 강제 탈퇴/삭제 연동]
  const btnDeleteUser = document.getElementById('btn-delete-user');
  if (btnDeleteUser) {
    btnDeleteUser.addEventListener('click', async () => {
      if (!selectedUser) return;
      if (confirm(`⚠️ [영구 차단 경고]\n'${selectedUser.store}' 매장 (${selectedUser.name} 사장님) 계정을 데이터베이스에서 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) {
        try {
          const res = await fetch(`${API_BASE}/admin/users/${selectedUser.id}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            alert('사장님 회원 계정이 데이터베이스에서 영구 삭제되었습니다.');
            closeUserDrawer();
            // 삭제된 회원을 계속 세던 패널까지 전부 갱신한다 — 예전엔 목록·통계만 새로
            // 읽어서 유입 경로 '전체 N명'과 이탈 위험 목록에 없는 회원이 남아 있었다.
            await Promise.all([loadUsers(), loadDashboardStats(), loadAcquisition(), loadActivity()]);
          } else {
            alert(`계정 삭제 실패: ${await describeError(res)}`);
          }
        } catch (err) {
          console.error(err);
          alert('서버 통신 중 에러가 발생하여 계정 삭제를 처리하지 못했습니다.');
        }
      }
    });
  }

  // 13. [한글 주석: 사장님 전용 푸시 알림 전송 및 발송 이력 관리]
  let currentNotifTarget = 'all';
  const targetPills = document.querySelectorAll('.target-pill');
  const specificSelect = document.getElementById('specific-user-select');

  targetPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      targetPills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      currentNotifTarget = pill.getAttribute('data-target');
      if (specificSelect) {
        specificSelect.style.display = currentNotifTarget === 'specific' ? 'block' : 'none';
      }
    });
  });

  const notifHistoryContainer = document.getElementById('notif-history-list');
  const notifHistoryCount = document.getElementById('notif-history-count');

  function renderNotifHistory() {
    if (!notifHistoryContainer) return;
    if (notifHistoryCount) notifHistoryCount.textContent = `${mockNotifHistory.length}건 등록됨`;

    notifHistoryContainer.innerHTML = mockNotifHistory
      .map(
        (n) => `
      <div class="notif-history-card">
        <div class="notif-history-header">
          <span class="notif-history-title">${n.title}</span>
          <span class="notif-history-time">${n.date || n.time}</span>
        </div>
        <div class="notif-history-body">${n.body || '내용 없음'}</div>
        <span class="notif-target-tag">수신: ${n.target}</span>
      </div>
    `
      )
      .join('');
  }

  // 알림 발송 시 특정 사장님 선택 드롭다운 채우기
  function updateSpecificUserSelect() {
    // 전체 발송 대상 수도 실제 회원 수로 — 예전엔 '(9명)'이 HTML에 박혀 있었다
    const allPill = document.getElementById('target-pill-all');
    if (allPill) allPill.textContent = `전체 사장님 (${mockUsers.length}명)`;

    if (!specificSelect) return;
    // value에 이메일을 담아야 백엔드가 특정 사장님 계정으로 정확히 매칭해 전달할 수 있다.
    specificSelect.innerHTML = '<option value="">-- 수신 점포 선택 --</option>' +
      mockUsers.map(u => `<option value="${u.email}">${u.store} (${u.name})</option>`).join('');
  }

  const notifForm = document.getElementById('notif-form');
  if (notifForm) {
    notifForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('notif-title').value.trim();
      const body = document.getElementById('notif-body').value.trim();
      if (!title || !body) return;

      let targetLabel = '전체 사장님';
      let targetEmail = null;
      // (프리미엄 회원만 보내기는 삭제됨 — 유료 등급이 없어졌다)
      if (currentNotifTarget === 'specific' && specificSelect) {
        targetEmail = specificSelect.value;
        if (!targetEmail) {
          alert('수신할 점포를 먼저 선택해 주세요.');
          return;
        }
        const opt = specificSelect.options[specificSelect.selectedIndex];
        targetLabel = `특정 매장 (${opt ? opt.textContent : targetEmail})`;
      }

      try {
        const res = await fetch(`${API_BASE}/admin/notifications`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title,
            body: body,
            target: targetLabel,
            target_type: currentNotifTarget,
            target_email: targetEmail
          })
        });
        // 실패해도 아무 반응이 없던 자리 — 성공과 구분이 안 돼 다시 눌러야 할지 알 수 없었다
        if (!res.ok) throw new Error(await describeError(res));
        const out = await res.json();
        document.getElementById('notif-title').value = '';
        document.getElementById('notif-body').value = '';

        // 몇 대에 실제로 갔는지 그대로 알린다 — '발송 완료'만 띄우면 0대여도 성공으로 읽힌다
        const d = out.delivery || {};
        const line = d.pushed > 0
          ? `푸시 ${d.pushed}대 발송 완료 (대상 ${d.targets}명)`
          : `푸시 발송 0대 — ${d.detail || '사유 미상'}`;
        alert(`📩 [공지 등록 완료] ${targetLabel}\n${line}\n\n푸시를 못 받은 사장님도 앱 홈 화면 알림함에서 확인할 수 있습니다.`);
        await loadNotifications();
      } catch (err) {
        console.error('공지 등록 실패:', err);
        alert(`공지를 등록하지 못했습니다 (${err.message}).\n입력 내용은 그대로 두었으니 다시 시도해 주세요.`);
      }
    });
  }

  // 14. [한글 주석: CS / 1:1 문의 데이터 및 관리 모달]
  // 14. [한글 주석: CS / 1:1 문의 데이터 백엔드 실시간 API 연동]
  let currentCSFilter = 'all';
  const csTableBody = document.getElementById('cs-table-body');
  let csLoadError = null; // 조회 실패 사유 — 표에 그대로 보여 준다 (빈 표와 구분되게)
  // 서버(GET /admin/cs)에서 받은 문의만 담는다.
  // 예전엔 여기 가짜 문의 1건이 시드로 박혀 있어, 조회에 실패해도 화면엔 뭔가 떠 있었다.
  let liveCSList = [];

  async function loadCSList() {
    try {
      const res = await fetch(`${API_BASE}/admin/cs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // 빈 배열도 그대로 반영한다 — 예전엔 length > 0일 때만 덮어써서, 문의를 모두
      // 처리하고 나면 지워진 목록이 계속 남아 있었다.
      liveCSList = (Array.isArray(data) ? data : []).map(item => ({
        id: item.id,
        store: item.store || item.store_name || '-',
        name: item.name || item.email || '사장님',
        category: item.category || '문의',
        title: item.title,
        date: item.date || '',
        status: item.status || '답변 대기',
        question: item.question || item.content || item.title,
        reply: item.reply || item.answer || '',
      }));
      csLoadError = null;
    } catch (err) {
      console.error('CS 목록 조회 실패:', err);
      csLoadError = err.message || String(err);
    }
    renderCSTable();
  }

  function renderCSTable() {
    if (!csTableBody) return;
    let list = liveCSList;
    if (currentCSFilter === 'waiting') {
      list = liveCSList.filter(c => c.status === '답변 대기' || c.status === 'pending' || c.status === 'waiting');
    } else if (currentCSFilter === 'done') {
      list = liveCSList.filter(c => c.status === '처리 완료' || c.status === 'answered' || c.status === 'done');
    }

    // 카운터 알약 뱃지 숫자 동적 갱신
    const totalCount = liveCSList.length;
    const waitingCount = liveCSList.filter(c => c.status === '답변 대기' || c.status === 'pending' || c.status === 'waiting').length;
    const doneCount = liveCSList.filter(c => c.status === '처리 완료' || c.status === 'answered' || c.status === 'done').length;

    const pills = document.querySelectorAll('.cs-filter-pill');
    if (pills.length >= 3) {
      pills[0].textContent = `전체 문의 (${totalCount}건)`;
      pills[1].textContent = `⏳ 답변 대기 (${waitingCount}건)`;
      pills[2].textContent = `✅ 처리 완료 (${doneCount}건)`;
    }

    // 사이드바 배지 — 다른 탭을 보고 있어도 밀린 문의가 눈에 띈다
    const navBadge = document.getElementById('nav-cs-badge');
    if (navBadge) {
      navBadge.textContent = waitingCount;
      navBadge.style.display = waitingCount > 0 ? '' : 'none';
    }

    if (list.length === 0) {
      // 조회에 실패한 것과 정말 0건인 것은 완전히 다른 상황이다 — 구분해서 말한다
      const msg = csLoadError
        ? `문의 목록을 불러오지 못했습니다 (${csLoadError}). 백엔드 주소와 로그인을 확인해 주세요.`
        : '해당 조건에 해당하는 문의 내역이 없습니다.';
      csTableBody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center; padding:30px; color:${csLoadError ? '#c62828' : '#8C6F56'};">
            ${msg}
          </td>
        </tr>`;
      return;
    }

    csTableBody.innerHTML = list.map(c => {
      const isDone = c.status === '처리 완료' || c.status === 'answered' || c.status === 'done';
      const statusLabel = isDone ? '처리 완료' : '답변 대기';
      return `
        <tr class="clickable-row" onclick="openCSModal(${c.id})">
          <td>#CS-${c.id}</td>
          <td><strong>${c.store}</strong> (${c.name})</td>
          <td><span class="feed-plan-chip">${c.category}</span></td>
          <td>${c.title}</td>
          <td>${c.date}</td>
          <td><span class="status-badge ${isDone ? 'green-bg' : 'amber-bg pulse'}">${isDone ? '✅ ' : '⏳ '}${statusLabel}</span></td>
          <td><button class="link-btn" onclick="event.stopPropagation(); openCSModal(${c.id})">${isDone ? '답변확인' : '답변하기'}</button></td>
        </tr>
      `;
    }).join('');
  }

  const csFilterPills = document.querySelectorAll('.cs-filter-pill');
  csFilterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      csFilterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentCSFilter = pill.getAttribute('data-cs-filter');
      renderCSTable();
    });
  });

  let selectedCSItem = null;
  const csModalOverlay = document.getElementById('cs-modal-overlay');
  const csModalCloseBtn = document.getElementById('cs-modal-close-btn');

  window.openCSModal = function(id) {
    const item = liveCSList.find(c => c.id === id);
    if (!item) return;
    selectedCSItem = item;

    document.getElementById('cs-modal-id').textContent = `#CS-${item.id}`;
    document.getElementById('cs-modal-store').textContent = `${item.store} (${item.name})`;
    document.getElementById('cs-modal-date').textContent = item.date;
    document.getElementById('cs-modal-question').textContent = item.question || item.title;
    document.getElementById('cs-answer-input').value = item.reply || '';

    if (window.lucide) lucide.createIcons();
    if (csModalOverlay) csModalOverlay.classList.add('active');
  };

  if (csModalCloseBtn) {
    csModalCloseBtn.addEventListener('click', () => {
      if (csModalOverlay) csModalOverlay.classList.remove('active');
    });
  }
  // 바깥을 눌러도 닫힌다 — 회원 Drawer는 되는데 이 모달만 X 버튼으로만 닫혔다
  if (csModalOverlay) {
    csModalOverlay.addEventListener('click', (e) => {
      if (e.target === csModalOverlay) csModalOverlay.classList.remove('active');
    });
  }

  const btnSendCSAnswer = document.getElementById('btn-send-cs-answer');
  if (btnSendCSAnswer) {
    btnSendCSAnswer.addEventListener('click', async () => {
      if (!selectedCSItem) return;
      const answerText = document.getElementById('cs-answer-input').value.trim();
      if (!answerText) {
        alert('사장님께 전송할 답변 내용을 입력해 주세요!');
        return;
      }

      // 저장에 실패하면 실패라고 말한다.
      // 예전엔 응답이 401·404·500이든 네트워크가 끊겼든 전부 "정상 전달되었습니다!"를 띄우고
      // 화면의 상태만 '처리 완료'로 바꿨다. 관리자는 답변한 줄 알지만 사장님에게는
      // 아무것도 안 갔고, 4초 뒤 폴링이 그 행을 조용히 '답변 대기'로 되돌렸다.
      const btn = btnSendCSAnswer;
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/admin/cs/${selectedCSItem.id}/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reply: answerText })
        });
        if (!res.ok) throw new Error(await describeError(res));
        alert(`💌 [답변 전달 완료] ${selectedCSItem.store} 사장님께 답변이 전달되었습니다!`);
        if (csModalOverlay) csModalOverlay.classList.remove('active');
        await loadCSList();
      } catch (err) {
        console.error('CS 답변 전송 실패:', err);
        // 모달을 닫지 않는다 — 입력한 답변이 남아 있어야 다시 누를 수 있다
        alert(`답변을 전송하지 못했습니다 (${err.message}).\n답변 내용은 그대로 두었으니 잠시 후 다시 시도해 주세요.`);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // 초기 로드와 자동 동기화는 initDashboard() 한 곳에서만 건다.
  // 예전엔 여기서도 3초 폴링을 걸어 두어 같은 목록을 3초·4초 두 타이머가 동시에
  // 긁었다 (요청이 두 배).

  // (삭제됨) 15. 결제 & 구독 매출 관리 — 유료 플랜 폐지로 탭·테이블이 모두 사라졌다

  // ---------------------------------------------------------------------------
  // 🩺 [한글 주석: 백엔드 API로부터 실시간 데이터 로드 함수 정의]
  // ---------------------------------------------------------------------------
  // 조회에 실패했는데 화면이 그대로면 '0명·0건'이 사실인 줄 알게 된다.
  // 실패한 영역은 실패했다고 표시한다 (유입 경로·활동 분석이 이미 쓰는 방식).
  function markPanelOffline(tagId) {
    const tag = document.getElementById(tagId);
    if (tag) { tag.textContent = 'OFFLINE'; tag.style.background = '#C62828'; }
  }

  function markPanelLive(tagId) {
    const tag = document.getElementById(tagId);
    if (tag) { tag.textContent = 'LIVE'; tag.style.background = ''; }
  }

  async function loadUsers() {
    try {
      const res = await fetch(`${API_BASE}/admin/users`);
      if (!res.ok) throw new Error(await describeError(res));
      mockUsers = await res.json();
      renderUserTable();
      renderTimelineFeed();
      updateSpecificUserSelect();
      markPanelLive('users-live-tag');
    } catch (err) {
      console.error('회원 목록 조회 실패:', err);
      markPanelOffline('users-live-tag');
      if (userTableBody) {
        userTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;color:#C62828;">
          회원 목록을 불러오지 못했습니다 (${err.message}).</td></tr>`;
      }
    }
  }

  async function loadDashboardStats() {
    try {
      const res = await fetch(`${API_BASE}/admin/dashboard/stats`);
      if (!res.ok) throw new Error(await describeError(res));
      const data = await res.json();
      document.getElementById('stats-total-stores').innerHTML = `${data.totalStores}<span class="unit">명</span>`;
      // 프리미엄 비율 자리는 '미답변 문의'로 교체됐다 (유료 플랜 폐지)
      const pendingEl = document.getElementById('stats-pending-cs');
      if (pendingEl) pendingEl.innerHTML = `${data.pendingInquiries ?? 0}<span class="unit">건</span>`;
      document.getElementById('stats-total-ingredients').innerHTML = `${data.totalIngredients}<span class="unit">품목</span>`;
      // OCR 처리 건수 — 예전엔 (구) activeUsersCount 필드를 읽어 라벨과 값이 어긋났다
      document.getElementById('stats-ocr-count').innerHTML = `${data.ocrCount ?? 0}<span class="unit">건</span>`;
      markStatsFresh(true);
    } catch (err) {
      console.error('통계 로드 실패:', err);
      // 숫자를 예전 값으로 남겨 두되, 그게 최신이 아니라는 걸 밝힌다
      markStatsFresh(false, err.message);
    }
  }

  // 지표 카드 하단 캡션 — 예전엔 '실시간 연동 중'이 무조건 박혀 있어서
  // 조회가 실패해 옛 숫자가 그대로 떠 있어도 실시간이라고 우겼다.
  function markStatsFresh(ok, reason) {
    const el = document.getElementById('stats-total-stores-sub');
    if (!el) return;
    el.textContent = ok ? `${nowLabel()} 기준` : `갱신 실패 — ${reason || '연결 확인 필요'}`;
    el.className = ok ? 'metric-sub green-text' : 'metric-sub';
    el.style.color = ok ? '' : '#C62828';
  }

  function nowLabel() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // (삭제됨) 중복 loadCSList — 같은 스코프에 두 번 선언돼 위 구현을 덮어쓰고,
  //          아무도 읽지 않는 변수에 담아서 표가 영원히 비어 있었다.

  async function loadNotifications() {
    try {
      const res = await fetch(`${API_BASE}/admin/notifications`);
      if (!res.ok) throw new Error(await describeError(res));
      mockNotifHistory = await res.json();
      renderNotifHistory();
    } catch (err) {
      console.error('공지 이력 조회 실패:', err);
      if (notifHistoryCount) notifHistoryCount.textContent = '불러오기 실패';
      if (notifHistoryContainer) {
        notifHistoryContainer.innerHTML =
          `<div style="padding:20px;text-align:center;color:#C62828;">공지 이력을 불러오지 못했습니다 (${err.message}).</div>`;
      }
    }
  }

  // (삭제됨) loadPayments — 결제·구독 폐지

  // ---------------------------------------------------------------------------
  // 15-b. [유입 경로 분석] 채널별 분포를 도넛 + 막대 범례로 렌더
  // ---------------------------------------------------------------------------
  // 채널 키 → 색상 팔레트 (브랜드 톤에 맞춘 커피 계열 + 포인트)
  const ACQ_COLORS = {
    referral:   '#7A5C4D', // 모카
    web_search: '#4E7D3A', // 그린
    instagram:  '#C07030', // 오렌지
    app_store:  '#3E291F', // 에스프레소
    youtube:    '#B0413E', // 레드브라운
    naver_blog: '#A89F91', // 스톤
    etc:        '#D8CBBB', // 샌드
  };

  async function loadAcquisition() {
    const liveTag = document.getElementById('acq-live-tag');
    try {
      const res = await fetch(`${API_BASE}/admin/dashboard/acquisition`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderAcquisition(data);
      if (liveTag) { liveTag.textContent = 'LIVE'; liveTag.style.background = ''; }
    } catch (err) {
      console.error('유입 경로 집계 실패:', err);
      if (liveTag) { liveTag.textContent = 'OFFLINE'; liveTag.style.background = '#C62828'; }
      const legend = document.getElementById('acq-legend');
      if (legend) legend.innerHTML = '<div class="acq-note">⚠️ 백엔드(8000) 연결에 실패해 유입 경로를 불러오지 못했습니다.</div>';
    }
  }

  function renderAcquisition(data) {
    const total = data.total || 0;
    const channels = (data.channels || []).filter(c => c.count > 0);

    // 총계 카운터
    const totalEl = document.getElementById('acq-total');
    if (totalEl) totalEl.textContent = total;

    // 도넛(SVG stroke-dasharray 방식) — 둘레 100 기준으로 채널별 호를 이어붙인다
    const donut = document.getElementById('acq-donut');
    if (donut) {
      const R = 15.9155; // 둘레 ≈ 100이 되는 반지름
      let offset = 0;
      const segs = channels.map(c => {
        const color = ACQ_COLORS[c.key] || '#D8CBBB';
        const pct = total > 0 ? (c.count / total * 100) : 0;
        const seg = `<circle class="acq-seg" cx="21" cy="21" r="${R}" stroke="${color}"
          stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}"
          stroke-dashoffset="${(-offset).toFixed(2)}"></circle>`;
        offset += pct;
        return seg;
      }).join('');
      // 데이터가 없을 때는 회색 링만
      donut.innerHTML = segs || `<circle class="acq-seg" cx="21" cy="21" r="${R}" stroke="var(--muted-sand)" stroke-dasharray="100 0"></circle>`;
    }

    // 우측 막대 범례
    const legend = document.getElementById('acq-legend');
    if (legend) {
      const maxRatio = Math.max(...channels.map(c => c.ratio), 1);
      legend.innerHTML = channels.map(c => {
        const color = ACQ_COLORS[c.key] || '#D8CBBB';
        const width = (c.ratio / maxRatio * 100).toFixed(1);
        return `
          <div class="acq-row">
            <span class="acq-dot" style="background:${color}"></span>
            <span class="acq-row-name">${c.label}</span>
            <span class="acq-bar-track"><span class="acq-bar-fill" style="width:${width}%;background:${color}"></span></span>
            <span class="acq-row-val">${c.count}명 · ${c.ratio}%</span>
          </div>`;
      }).join('') || '<div class="acq-note">아직 집계할 회원이 없습니다.</div>';
    }

    // 하단 안내 — 시딩 투명성 문구
    const note = document.getElementById('acq-note');
    if (note) {
      const seeded = data.seeded_count || 0;
      if (seeded > 0) {
        note.innerHTML = `ℹ️ 전체 ${total}명 중 <b>${seeded}명</b>은 유입 채널 실수집 데이터가 없어 데모용 추정값으로 배정되었습니다. 실제 가입 데이터가 쌓이면 자동으로 실측값으로 대체됩니다.`;
      } else {
        note.textContent = `✅ 전체 ${total}명 모두 실수집된 유입 채널 데이터입니다.`;
      }
    }

    if (window.lucide) window.lucide.createIcons();
  }

  // ---------------------------------------------------------------------------
  // 15-c. [활동·리텐션 분석] 접속 활성도·기능별 사용량·이탈 위험 회원 렌더
  // ---------------------------------------------------------------------------
  async function loadActivity() {
    const liveTag = document.getElementById('act-live-tag');
    try {
      const res = await fetch(`${API_BASE}/admin/dashboard/activity`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderActivity(data);
      if (liveTag) { liveTag.textContent = 'LIVE'; liveTag.style.background = ''; }
    } catch (err) {
      console.error('활동 분석 집계 실패:', err);
      if (liveTag) { liveTag.textContent = 'OFFLINE'; liveTag.style.background = '#C62828'; }
    }
  }

  function renderActivity(data) {
    const setVal = (id, v, unit) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `${v}<span class="unit">${unit}</span>`;
    };
    setVal('act-today', data.activeToday || 0, '명');
    setVal('act-week', data.activeThisWeek || 0, '명');
    setVal('act-month', data.activeThisMonth || 0, '명');
    setVal('act-events', (data.totalEvents || 0).toLocaleString(), '건');
    setVal('act-risk-count', data.atRiskCount || 0, '명');

    // 기능별 사용량 막대
    const fl = document.getElementById('act-feature-list');
    if (fl) {
      const feats = data.featureUsage || [];
      const max = Math.max(...feats.map(f => f.count), 1);
      fl.innerHTML = feats.map(f => {
        const w = (f.count / max * 100).toFixed(1);
        return `
          <div class="act-feature-row">
            <span class="act-feature-name">${f.feature}</span>
            <span class="act-feature-track"><span class="act-feature-fill" style="width:${w}%"></span></span>
            <span class="act-feature-val">${f.count.toLocaleString()}건</span>
          </div>`;
      }).join('') || '<div class="act-empty">아직 집계된 활동 이벤트가 없습니다.</div>';
    }

    // 이탈 위험 회원 리스트
    const rl = document.getElementById('act-risk-list');
    const sub = document.getElementById('act-risk-sub');
    if (sub) sub.textContent = `(${data.atRiskDays || 7}일+ 미접속)`;
    if (rl) {
      const risk = data.atRisk || [];
      rl.innerHTML = risk.map(r => {
        const badge = r.days_inactive == null
          ? '접속 이력 없음'
          : `${r.days_inactive}일 미접속`;
        return `
          <div class="act-risk-item">
            <div class="act-risk-info">
              <div class="act-risk-name">${r.name} · ${r.store}</div>
              <div class="act-risk-store">${r.email}${r.last_active ? ' · 마지막 ' + r.last_active : ''}</div>
            </div>
            <span class="act-risk-badge">${badge}</span>
          </div>`;
      }).join('') || '<div class="act-empty">✅ 이탈 위험 회원이 없습니다. 모두 최근 접속했습니다.</div>';
    }

    if (window.lucide) window.lucide.createIcons();
  }

  // ---------------------------------------------------------------------------
  // 16. [한글 주석: AI 에이전트 오케스트레이션 편성 조회 및 트리 렌더링]
  // ---------------------------------------------------------------------------
  let agentOverview = null;
  const expandedExperts = new Set(); // 도구 목록이 펼쳐진 전문가 이름 보관

  // 전문가별 대표 아이콘 매핑 (lucide)
  const AGENT_ICON_MAP = {
    inventory_expert: 'package',
    document_expert: 'file-text',
    ocr_expert: 'scan-line',
    operation_expert: 'trending-up',
    report_expert: 'bar-chart-3',
    search_expert: 'globe',
  };

  window.loadAgents = async function (manual = false) {
    const wrap = document.getElementById('agent-orchestra');
    if (!wrap) return;

    const refreshBtn = document.querySelector('#tab-agents .health-refresh-btn');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    try {
      const res = await fetch(`${API_BASE}/chatbot/agents`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      agentOverview = await res.json();
      renderAgentMetrics();
      renderAgentRuntime();
      renderAgentTree();
    } catch (err) {
      console.error('에이전트 편성 조회 실패:', err);
      wrap.innerHTML = `
        <div class="orchestra-loading error">
          ⚠️ 백엔드(8000) 연결에 실패해 에이전트 편성을 불러오지 못했습니다.<br>
          FastAPI 서버가 켜져 있는지 확인한 뒤 새로고침 버튼을 눌러 주세요.
        </div>`;
      const liveTag = document.getElementById('agents-live-tag');
      if (liveTag) { liveTag.textContent = 'OFFLINE'; liveTag.style.background = '#C62828'; }
    } finally {
      if (refreshBtn) setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
    }
  };

  function renderAgentMetrics() {
    if (!agentOverview) return;
    const d = agentOverview;

    document.getElementById('agents-active-count').innerHTML =
      `${d.active_experts}<span class="unit"> / ${d.total_experts}명</span>`;
    document.getElementById('agents-tool-count').innerHTML =
      `${d.total_tools}<span class="unit">개</span>`;
    document.getElementById('agents-model').textContent = d.main.model || '-';
    document.getElementById('agents-trace').textContent = d.langsmith_enabled ? 'ON' : 'OFF';

    const keySub = document.getElementById('agents-api-key-sub');
    if (keySub) {
      keySub.textContent = d.main.api_key_set ? 'GEMINI API 키 정상 등록됨' : '⚠️ GEMINI API 키 미설정';
      keySub.className = d.main.api_key_set ? 'metric-sub green-text' : 'metric-sub';
    }

    const liveTag = document.getElementById('agents-live-tag');
    if (liveTag) { liveTag.textContent = 'LIVE'; liveTag.style.background = ''; }
  }

  // ---------------------------------------------------------------------------
  // 16-b. [챗봇 실행 현황] 편성표가 아니라 '실제로 돌아간 결과'.
  //       숫자는 백엔드 프로세스 메모리에 쌓인다 — 재시작하면 0부터라 집계 시작 시각을 함께 보여 준다.
  // ---------------------------------------------------------------------------
  function fmtDuration(ms) {
    if (!ms) return '-';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}<span class="unit">초</span>` : `${Math.round(ms)}<span class="unit">ms</span>`;
  }

  function renderAgentRuntime() {
    const rt = agentOverview && agentOverview.runtime;
    if (!rt) return;
    const $ = (id) => document.getElementById(id);

    if ($('rt-since')) $('rt-since').textContent = `집계 시작 ${rt.since_label || '-'}`;
    if ($('rt-turns')) $('rt-turns').innerHTML = `${(rt.turns || 0).toLocaleString()}<span class="unit">턴</span>`;
    if ($('rt-okrate')) $('rt-okrate').innerHTML = rt.ok_rate === null || rt.ok_rate === undefined
      ? '-' : `${rt.ok_rate}<span class="unit">%</span>`;
    if ($('rt-avg')) $('rt-avg').innerHTML = fmtDuration(rt.avg_ms);
    if ($('rt-p95')) $('rt-p95').innerHTML = fmtDuration(rt.p95_ms);
    if ($('rt-failed')) $('rt-failed').innerHTML = `${rt.failed || 0}<span class="unit">턴</span>`;

    // 막대 목록 — 유입 경로·기능별 사용량과 같은 모양(act-feature-row)을 재사용한다
    const bars = (rows, nameOf, valOf, empty) => {
      const max = Math.max(...rows.map(valOf), 1);
      return rows.map((r) => `
        <div class="act-feature-row">
          <span class="act-feature-name">${nameOf(r)}</span>
          <span class="act-feature-track"><span class="act-feature-fill" style="width:${(valOf(r) / max * 100).toFixed(1)}%"></span></span>
          <span class="act-feature-val">${valOf(r).toLocaleString()}회</span>
        </div>`).join('') || `<div class="act-empty">${empty}</div>`;
    };

    if ($('rt-expert-list')) {
      const experts = (rt.experts || []).filter((e) => e.calls > 0);
      $('rt-expert-list').innerHTML = bars(
        experts,
        (e) => `${e.name}${e.avg_ms ? ` <span class="rt-sub">평균 ${(e.avg_ms / 1000).toFixed(1)}초</span>` : ''}${e.failures ? ` <span class="rt-fail">실패 ${e.failures}</span>` : ''}`,
        (e) => e.calls,
        '아직 위임된 작업이 없습니다. 챗봇에서 질문이 오면 여기에 쌓입니다.',
      );
    }

    if ($('rt-tool-list')) {
      $('rt-tool-list').innerHTML = bars(
        (rt.tools || []).filter((t) => t.calls > 0),
        (t) => `${t.name}${t.failures ? ` <span class="rt-fail">실패 ${t.failures}</span>` : ''}`,
        (t) => t.calls,
        '아직 호출된 도구가 없습니다.',
      );
    }

    // 실패 사유 — 조치가 갈리므로(키/한도/DB/코드) 뭉뚱그리지 않는다
    if ($('rt-failure-list')) {
      const reasons = rt.failure_reasons || [];
      $('rt-failure-list').innerHTML = reasons.length
        ? reasons.map((r) => `<span class="rt-failure-chip">${r.label} <b>${r.count}</b></span>`).join('')
        : '';
    }

    // 최근 실행 기록
    const body = $('rt-recent-body');
    const count = $('rt-recent-count');
    const recent = rt.recent || [];
    if (count) count.textContent = recent.length ? `최근 ${recent.length}턴` : '기록 없음';
    if (body) {
      body.innerHTML = recent.length
        ? recent.map((r) => `
          <tr>
            <td>${r.at}</td>
            <td>${r.store_id}</td>
            <td class="rt-question">${(r.question || '').replace(/</g, '&lt;') || '-'}</td>
            <td>${r.experts && r.experts.length ? r.experts.join(', ') : '<span class="rt-muted">위임 없음</span>'}</td>
            <td>${r.tool_calls ? `${r.tool_calls}회` : '<span class="rt-muted">-</span>'}</td>
            <td>${(r.ms / 1000).toFixed(1)}초</td>
            <td><span class="status-badge ${r.ok ? 'green-bg' : 'cancel'}">${r.ok ? '정상' : r.reason_label}</span></td>
          </tr>`).join('')
        : `<tr><td colspan="7" style="text-align:center;padding:26px;color:#8A7A71;">
             아직 오간 대화가 없습니다. 앱 챗봇에서 질문이 들어오면 여기에 실시간으로 쌓입니다.</td></tr>`;
    }
  }

  function renderAgentTree() {
    const wrap = document.getElementById('agent-orchestra');
    if (!wrap || !agentOverview) return;
    const d = agentOverview;

    // 1) 상단: 사용자 → 메인 에이전트 카드
    const mainCard = `
      <div class="orchestra-user-node">
        <i data-lucide="user-round"></i>
        <span>사장님 질문 (챗봇 화면)</span>
      </div>
      <div class="orchestra-connector short"></div>
      <div class="agent-main-card">
        <div class="agent-main-left">
          <div class="agent-main-avatar"><i data-lucide="brain-circuit"></i></div>
          <div>
            <div class="agent-main-name">${d.main.name}
              <span class="agent-role-chip">${d.main.role}</span>
              <span class="status-badge ${d.main.api_key_set ? 'green-bg' : 'amber-bg pulse'}">${d.main.api_key_set ? '● 가동 중' : '⏸ API 키 필요'}</span>
            </div>
            <div class="agent-main-desc">${d.main.description}</div>
          </div>
        </div>
        <div class="agent-main-meta">
          <div class="agent-meta-item"><span class="meta-label">모델</span><span class="meta-val">${d.main.model}</span></div>
          <div class="agent-meta-item"><span class="meta-label">메인 스텝 상한</span><span class="meta-val">${d.main.recursion_limit}</span></div>
          <div class="agent-meta-item"><span class="meta-label">서브 스텝 상한</span><span class="meta-val">${d.sub_recursion_limit}</span></div>
        </div>
      </div>
      <div class="orchestra-connector fan"></div>`;

    // 2) 하단: 서브 에이전트(전문가) 카드 그리드
    const expertCards = d.experts
      .map((e) => {
        const icon = AGENT_ICON_MAP[e.name] || 'bot';
        const isOpen = expandedExperts.has(e.name);
        const toolRows = e.tools
          .map(
            (t) => `
            <div class="agent-tool-row">
              <span class="agent-tool-name"><i data-lucide="wrench"></i>${t.name}${t.calls ? `<span class="agent-tool-calls">${t.calls}회</span>` : ''}</span>
              <span class="agent-tool-desc">${t.description || ''}</span>
            </div>`
          )
          .join('');

        return `
        <div class="agent-card ${e.active ? '' : 'inactive'} ${isOpen ? 'open' : ''}" onclick="toggleAgentTools('${e.name}')">
          <div class="agent-card-head">
            <div class="agent-card-avatar"><i data-lucide="${icon}"></i></div>
            <div class="agent-card-titles">
              <div class="agent-card-title">${e.title}</div>
              <div class="agent-card-code">${e.name}</div>
            </div>
            <span class="status-badge ${e.active ? 'green-bg' : 'brown-bg'}">${e.active ? '활성' : '비활성'}</span>
          </div>
          <div class="agent-card-desc">${e.description}</div>
          <div class="agent-card-foot">
            <span class="agent-tool-chip"><i data-lucide="wrench"></i> 도구 ${e.tool_count}개</span>
            <!-- 편성돼 있다고 실제로 쓰이는 건 아니다 — 서버 시작 이후 위임 횟수를 함께 보여 준다 -->
            <span class="agent-tool-chip ${e.calls ? 'used' : ''}"><i data-lucide="git-fork"></i> 위임 ${e.calls || 0}회</span>
            <span class="agent-expand-hint">${isOpen ? '▲ 접기' : '▼ 도구 목록 보기'}</span>
          </div>
          <div class="agent-tool-list" style="display: ${isOpen ? 'flex' : 'none'};">
            ${toolRows || '<div class="agent-tool-row"><span class="agent-tool-desc">로드된 도구가 없어 이 전문가는 챗봇 편성에서 제외됩니다.</span></div>'}
          </div>
        </div>`;
      })
      .join('');

    // 3) 하단: 기능 검증(QA) 멀티에이전트 편성 — 챗봇 편성과 별개로, 저장소 전체를
    //    기능 단위로 검증한 마지막 실행의 판정표 (qa_fleet.py 스냅샷)
    let qaSection = '';
    const qa = d.qa_fleet;
    if (qa && qa.subagents && qa.subagents.length) {
      const badge = (s) =>
        s === '정상' ? 'green-bg' : s === '경미한 문제' ? 'brown-bg' : 'red-bg';
      const qaCards = qa.subagents
        .map(
          (a) => `
        <div class="agent-card">
          <div class="agent-card-head">
            <div class="agent-card-avatar"><i data-lucide="shield-check"></i></div>
            <div class="agent-card-titles">
              <div class="agent-card-title">${a.title}</div>
              <div class="agent-card-code">${a.name}</div>
            </div>
            <span class="status-badge ${badge(a.status)}">${a.status}</span>
          </div>
          <div class="agent-card-desc">${a.note}</div>
        </div>`
        )
        .join('');
      qaSection = `
      <div class="agent-main-card" style="margin-top: 28px;">
        <div class="agent-main-head">
          <div class="agent-main-avatar"><i data-lucide="shield-check"></i></div>
          <div>
            <div class="agent-main-title-row">
              <span class="agent-main-name">${qa.main.title}</span>
              <span class="agent-card-code">${qa.main.name}</span>
            </div>
            <div class="agent-main-desc">${qa.main.description}</div>
          </div>
        </div>
        <div class="agent-main-meta">
          <div class="agent-meta-item"><span class="meta-label">서브 에이전트</span><span class="meta-val">${qa.total}개 (기능당 1개)</span></div>
          <div class="agent-meta-item"><span class="meta-label">판정</span><span class="meta-val">정상 ${qa.counts['정상'] || 0} · 경미 ${qa.counts['경미한 문제'] || 0} · 심각 ${qa.counts['심각한 문제'] || 0}</span></div>
          <div class="agent-meta-item"><span class="meta-label">마지막 검증</span><span class="meta-val">${qa.checked_at}</span></div>
        </div>
      </div>
      <div class="orchestra-connector fan"></div>
      <div class="agent-grid">${qaCards}</div>`;
    }

    wrap.innerHTML = mainCard + `<div class="agent-grid">${expertCards}</div>` + qaSection;
    if (window.lucide) lucide.createIcons();
  }

  window.toggleAgentTools = function (expertName) {
    if (expandedExperts.has(expertName)) {
      expandedExperts.delete(expertName);
    } else {
      expandedExperts.add(expertName);
    }
    renderAgentTree();
  };

  // 전체 새로고침 — 헤더 버튼과 초기 구동이 같은 함수를 쓴다
  async function refreshAll() {
    // 서로 의존하지 않는 조회라 동시에 보낸다 (하나씩 await하면 Neon RTT가 그대로 쌓인다)
    await Promise.all([
      checkBackendHealth(),
      loadDashboardStats(),
      loadUsers(),
      loadCSList(),
      loadNotifications(),
      loadAcquisition(),
      loadActivity(),
      loadAgents(),
    ]);
    const updated = document.getElementById('header-updated');
    if (updated) updated.textContent = `${nowLabel()} 갱신됨`;
  }

  const btnRefreshAll = document.getElementById('btn-refresh-all');
  if (btnRefreshAll) {
    btnRefreshAll.addEventListener('click', async () => {
      btnRefreshAll.disabled = true;
      btnRefreshAll.classList.add('spinning');
      try {
        await refreshAll();
      } finally {
        btnRefreshAll.disabled = false;
        btnRefreshAll.classList.remove('spinning');
      }
    });
  }

  // [한글 주석: 초기 구동 시 실시간 데이터 전면 동기화 + 주기적 자동 갱신]
  async function initDashboard() {
    await refreshAll();

    // 4초 주기 — 사장님이 문의를 접수하면 새로고침 없이 바로 뜬다
    setInterval(loadCSList, 4000);

    // 나머지 패널도 주기적으로 다시 읽는다.
    // 예전엔 initDashboard가 딱 한 번만 돌아서, 화면에 'LIVE'와 '실시간'이라고 써 있는데
    // 실제로는 페이지를 연 순간의 스냅샷이 몇 시간이고 그대로 남아 있었다.
    setInterval(async () => {
      // loadAgents도 함께 — 실행 현황(대화 턴·응답시간)은 계속 변한다. DB를 안 타는 조회라 가볍다.
      await Promise.all([checkBackendHealth(), loadDashboardStats(), loadUsers(), loadNotifications(), loadAgents()]);
      const updated = document.getElementById('header-updated');
      if (updated) updated.textContent = `${nowLabel()} 갱신됨`;
    }, 30000);

    setInterval(() => {
      loadAcquisition();
      loadActivity();
    }, 60000);
  }

  initDashboard();
});
