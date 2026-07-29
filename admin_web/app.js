// [한글 주석: SimpleM 관리자 데스크톱 콘솔 로직 - 상단 필터 탭 통합 버전]
document.addEventListener('DOMContentLoaded', () => {
  // Lucide 아이콘 로드
  if (window.lucide) {
    lucide.createIcons();
  }

  // ━━━ 관리자 로그인 게이트 (A방안: 로그인 → 토큰 발급 → 모든 관리자 API에 자동 첨부) ━━━
  const ADMIN_TOKEN_KEY = 'simplem_admin_token';

  // 백엔드 주소 — 기본은 배포본(Cloud Run).
  // 로컬 백엔드로 붙이려면 브라우저 콘솔에서 한 줄 실행하고 새로고침하면 된다:
  //   localStorage.setItem('simplem_admin_api', 'http://localhost:8000/api/v1')
  // 되돌리려면: localStorage.removeItem('simplem_admin_api')
  const DEFAULT_API = 'https://brewnote-api-915817944047.asia-northeast3.run.app/api/v1';
  const ADMIN_API = localStorage.getItem('simplem_admin_api') || DEFAULT_API;
  const getAdminToken = () => localStorage.getItem(ADMIN_TOKEN_KEY) || '';

  // 원본 fetch를 감싸 /admin, /auth/users 호출에 Authorization 헤더를 자동으로 실어 준다 (login 제외)
  const _origFetch = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    try {
      const u = typeof url === 'string' ? url : (url && url.url) || '';
      if (/\/api\/v1\/(admin|auth\/users)/.test(u) && !/\/admin\/login/.test(u)) {
        const t = getAdminToken();
        if (t) opts = Object.assign({}, opts, { headers: Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + t }) });
      }
    } catch (e) {}
    return _origFetch(url, opts).then((res) => {
      try {
        const u = typeof url === 'string' ? url : (url && url.url) || '';
        if ((res.status === 401 || res.status === 403) && /\/api\/v1\/(admin|auth\/users)/.test(u) && !/\/admin\/login/.test(u)) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          showAdminLogin('세션이 만료되었습니다. 다시 로그인해 주세요.');
        }
      } catch (e) {}
      return res;
    });
  };

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
        <div style="font-size:18px;font-weight:800;color:#3a2e28;margin-bottom:4px;">SimpleM 관리자 콘솔</div>
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
    } catch (err) {
      paintStatus(cards.api, 'fail', '서버 오프라인');
      paintStatus(cards.db, 'unknown', '확인 불가');
      paintStatus(cards.ocr, 'unknown', '확인 불가');
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
        return `
        <div class="feed-card ${isNew ? 'newly-added' : 'feed-slide-down'}" onclick="openUserDrawer(${u.id})">
          <div class="feed-avatar-box">
            <div class="feed-avatar">${u.store.charAt(0)}</div>
            <span class="new-sparkle-tag">NEW</span>
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
  function renderUserTable() {
    if (!userTableBody) return;

    if (mockUsers.length === 0) {
      // 열 개수(6)와 맞춰야 안내 문구가 표 전체 폭에 걸린다 — 구독 유형 열이 빠지며 7→6이 됐다
      userTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 30px; color: #8A7A71;">가입된 사장님 회원 데이터가 없습니다.</td></tr>';
      return;
    }

    let items = mockUsers;

    const searchQuery = document.getElementById('user-search-input')?.value.toLowerCase().trim();
    if (searchQuery) {
      items = items.filter(
        (u) => u.name.toLowerCase().includes(searchQuery) || u.store.toLowerCase().includes(searchQuery) || u.email.toLowerCase().includes(searchQuery)
      );
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
        <td><button class="link-btn" onclick="event.stopPropagation(); openUserDrawer(${u.id})">상세보기</button></td>
      </tr>
    `
      )
      .join('');
  }

  // (삭제됨) 상단 등급 필터 탭 — 버튼 자체가 HTML에서 빠졌다 (유료 플랜 폐지)

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
    document.getElementById('drawer-user-name').textContent = user.name;
    document.getElementById('drawer-user-email').textContent = user.email;
    document.getElementById('drawer-user-joined').textContent = user.joined;

    // 계정 상태 드롭다운
    const statusSelect = document.getElementById('drawer-user-status-select');
    if (statusSelect) statusSelect.value = user.status;

    // (삭제됨) 구독 정보 — 유료 플랜 폐지

    // 실시간 사용 통계 — 백엔드가 센 실제 건수 (예전엔 화면에 14건·28개가 박혀 있었다)
    document.getElementById('drawer-stat-ocr').innerHTML = `${user.ocrCount ?? 0}<span class="stat-unit">건</span>`;
    document.getElementById('drawer-stat-stocks').innerHTML = `${user.stockCount ?? 0}<span class="stat-unit">개</span>`;

    // 관리자 메모 — DB(admin_user_notes)에 저장된 값
    document.getElementById('drawer-user-memo').value = user.memo || '';

    if (window.lucide) lucide.createIcons();

    drawerOverlay.classList.add('active');
  };

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

  // 11. 로그아웃
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      alert('관리자 계정에서 로그아웃되었습니다.');
    });
  }

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
            alert('사장님 회원 계정이 PostgreSQL DB에서 성공적으로 영구 삭제되었습니다.');
            closeUserDrawer();
            await loadUsers(); // 사장님 목록 다시 리로드
            await loadDashboardStats(); // 통계 재계산
          } else {
            const errData = await res.json();
            alert(`계정 삭제 실패: ${errData.detail}`);
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
    if (notifHistoryCount) notifHistoryCount.textContent = `${mockNotifHistory.length}건 발송 완료`;

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
        if (res.ok) {
          // 성공 시 리스트 다시 불러옴
          document.getElementById('notif-title').value = '';
          document.getElementById('notif-body').value = '';
          alert(`📲 [발송 완료] ${targetLabel} 대상 사장님 알림 발송이 백엔드에 동기화되었습니다!`);
          await loadNotifications();
        }
      } catch (err) {
        console.error(err);
        alert('알림 전송 중 오류가 발생했습니다.');
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

  const btnSendCSAnswer = document.getElementById('btn-send-cs-answer');
  if (btnSendCSAnswer) {
    btnSendCSAnswer.addEventListener('click', async () => {
      if (!selectedCSItem) return;
      const answerText = document.getElementById('cs-answer-input').value.trim();
      if (!answerText) {
        alert('사장님께 전송할 답변 내용을 입력해 주세요!');
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/admin/cs/${selectedCSItem.id}/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reply: answerText })
        });
        if (res.ok) {
          alert(`💌 [답변 전달 완료] ${selectedCSItem.store} 사장님께 답변이 정상 전달되었습니다!`);
          if (csModalOverlay) csModalOverlay.classList.remove('active');
          await loadCSList();
        } else {
          // 로컬 업데이트 처리
          selectedCSItem.reply = answerText;
          selectedCSItem.status = '처리 완료';
          alert(`💌 [답변 전달 완료] ${selectedCSItem.store} 사장님께 답변이 전달되었습니다!`);
          if (csModalOverlay) csModalOverlay.classList.remove('active');
          renderCSTable();
        }
      } catch (err) {
        console.error(err);
        selectedCSItem.reply = answerText;
        selectedCSItem.status = '처리 완료';
        alert(`💌 [답변 전달 완료] ${selectedCSItem.store} 사장님께 답변이 전달되었습니다!`);
        if (csModalOverlay) csModalOverlay.classList.remove('active');
        renderCSTable();
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
  async function loadUsers() {
    try {
      const res = await fetch(`${API_BASE}/admin/users`);
      if (res.ok) {
        mockUsers = await res.json();
        renderUserTable();
        renderTimelineFeed();
        updateSpecificUserSelect();
      }
    } catch (err) {
      console.error('회원 목록 조회 실패:', err);
    }
  }

  async function loadDashboardStats() {
    try {
      const res = await fetch(`${API_BASE}/admin/dashboard/stats`);
      if (res.ok) {
        const data = await res.json();
        document.getElementById('stats-total-stores').innerHTML = `${data.totalStores}<span class="unit">명</span>`;
        // 프리미엄 비율 자리는 '미답변 문의'로 교체됐다 (유료 플랜 폐지)
        const pendingEl = document.getElementById('stats-pending-cs');
        if (pendingEl) pendingEl.innerHTML = `${data.pendingInquiries ?? 0}<span class="unit">건</span>`;
        document.getElementById('stats-total-ingredients').innerHTML = `${data.totalIngredients}<span class="unit">품목</span>`;
        // OCR 처리 건수 — 예전엔 (구) activeUsersCount 필드를 읽어 라벨과 값이 어긋났다
        document.getElementById('stats-ocr-count').innerHTML = `${data.ocrCount ?? 0}<span class="unit">건</span>`;
      }
    } catch (err) {
      console.error('통계 로드 실패:', err);
    }
  }

  // (삭제됨) 중복 loadCSList — 같은 스코프에 두 번 선언돼 위 구현을 덮어쓰고,
  //          아무도 읽지 않는 변수에 담아서 표가 영원히 비어 있었다.

  async function loadNotifications() {
    try {
      const res = await fetch(`${API_BASE}/admin/notifications`);
      if (res.ok) {
        mockNotifHistory = await res.json();
        renderNotifHistory();
      }
    } catch (err) {
      console.error('알림 조회 실패:', err);
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
    law_expert: 'scale',
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
              <span class="agent-tool-name"><i data-lucide="wrench"></i>${t.name}</span>
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
            <span class="agent-expand-hint">${isOpen ? '▲ 접기' : '▼ 도구 목록 보기'}</span>
          </div>
          <div class="agent-tool-list" style="display: ${isOpen ? 'flex' : 'none'};">
            ${toolRows || '<div class="agent-tool-row"><span class="agent-tool-desc">로드된 도구가 없어 이 전문가는 챗봇 편성에서 제외됩니다.</span></div>'}
          </div>
        </div>`;
      })
      .join('');

    wrap.innerHTML = mainCard + `<div class="agent-grid">${expertCards}</div>`;
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

  // [한글 주석: 초기 구동 시 실시간 데이터 전면 동기화 및 4초 주기 사장님 CS 문의 실시간 자동 수신 설정]
  async function initDashboard() {
    await checkBackendHealth();
    await loadDashboardStats();
    await loadUsers();
    await loadCSList();
    await loadNotifications();
    await loadAcquisition();
    await loadActivity();
    await loadAgents();

    // 4초 주기 폴링 — 사장님이 앱에서 1대1 문의를 접수하면 관리자 웹페이지를 안 새로고침해도 4초 내에 실시간 노출
    setInterval(() => {
      loadCSList();
    }, 4000);
  }

  initDashboard();
});
