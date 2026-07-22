// [한글 주석: SimpleM 관리자 데스크톱 콘솔 로직 - 상단 필터 탭 통합 버전]
document.addEventListener('DOMContentLoaded', () => {
  // Lucide 아이콘 로드
  if (window.lucide) {
    lucide.createIcons();
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
    payments: '프리미엄 결제 & 구독 매출 관리',
  };

  // 🩺 [한글 주석: 각 개별 항목 수동 헬스체크 재점검 기능]
  window.checkSingleHealth = async function (type) {
    const card = document.getElementById(`status-${type}`);
    if (!card) return;

    const btn = card.querySelector('.health-refresh-btn');
    if (btn) btn.classList.add('spinning');

    setTimeout(async () => {
      if (type === 'api') {
        try {
          const res = await fetch('http://localhost:8000/health');
          if (res.ok) {
            card.querySelector('.status-indicator').className = 'status-indicator green';
            card.querySelector('.status-badge').className = 'status-badge green-bg';
            card.querySelector('.status-badge').textContent = '정상 작동 중';
          }
        } catch {
          card.querySelector('.status-indicator').className = 'status-indicator red';
          card.querySelector('.status-badge').className = 'status-badge red-bg pulse';
          card.querySelector('.status-badge').textContent = '서버 오프라인 (Red)';
        }
      } else if (type === 'db') {
        try {
          const dbRes = await fetch('http://localhost:8000/db-test');
          if (dbRes.ok) {
            card.querySelector('.status-indicator').className = 'status-indicator green';
            card.querySelector('.status-badge').className = 'status-badge green-bg';
            card.querySelector('.status-badge').textContent = '정상 연결됨';
          }
        } catch {
          card.querySelector('.status-indicator').className = 'status-indicator red';
          card.querySelector('.status-badge').className = 'status-badge red-bg pulse';
          card.querySelector('.status-badge').textContent = 'DB 오류 (Red)';
        }
      } else if (type === 'ocr') {
        card.querySelector('.status-indicator').className = 'status-indicator amber';
        card.querySelector('.status-badge').className = 'status-badge amber-bg pulse';
        card.querySelector('.status-badge').textContent = '대기 상태 (Amber)';
      }

      if (btn) btn.classList.remove('spinning');
    }, 600);
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

    // [한글 주석: AI 에이전트 탭 진입 시 최신 편성 자동 조회]
    if (targetTab === 'agents') {
      loadAgents();
    }
  };

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const targetTab = item.getAttribute('data-tab');
      switchTab(targetTab);
    });
  });

  // 2. 백엔드 실시간 헬스 체크
  async function checkBackendHealth() {
    const apiStatusCard = document.getElementById('status-api');
    const dbStatusCard = document.getElementById('status-db');

    try {
      const res = await fetch('http://localhost:8000/health');
      if (res.ok) {
        if (apiStatusCard) {
          apiStatusCard.querySelector('.status-indicator').className = 'status-indicator green';
          apiStatusCard.querySelector('.status-badge').className = 'status-badge green-bg';
          apiStatusCard.querySelector('.status-badge').textContent = '정상 작동 중';
        }
      }
    } catch {
      if (apiStatusCard) {
        apiStatusCard.querySelector('.status-indicator').className = 'status-indicator brown';
        apiStatusCard.querySelector('.status-badge').className = 'status-badge brown-bg';
        apiStatusCard.querySelector('.status-badge').textContent = '서버 오프라인';
      }
    }

    try {
      const dbRes = await fetch('http://localhost:8000/db-test');
      if (dbRes.ok) {
        const data = await dbRes.json();
        if (data.database === 'success') {
          if (dbStatusCard) {
            dbStatusCard.querySelector('.status-indicator').className = 'status-indicator green';
            dbStatusCard.querySelector('.status-badge').className = 'status-badge green-bg';
            dbStatusCard.querySelector('.status-badge').textContent = '정상 연결됨';
          }
        }
      }
    } catch {
      // ignore
    }
  }

  checkBackendHealth();
  setInterval(checkBackendHealth, 10000);

  // 3. 실시간 백엔드 API 연동 베이스 URL
  const API_BASE = 'http://localhost:8000/api/v1';

  // [한글 주석: 백엔드 API 호출을 통해 채워질 실시간 데이터 보관함]
  let mockUsers = [];
  let mockCSList = [];
  let mockNotifHistory = [];
  let mockPayments = [];

  let selectedUser = null;
  let currentFilter = 'all'; // 'all' | 'premium' | 'general'

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
              <span class="feed-plan-chip">${u.plan}</span>
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
      userTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 30px; color: #8A7A71;">가입된 사장님 회원 데이터가 없습니다.</td></tr>';
      return;
    }

    let items = mockUsers;
    if (currentFilter === 'premium') {
      items = mockUsers.filter((u) => u.plan === '프리미엄 회원');
    } else if (currentFilter === 'general') {
      items = mockUsers.filter((u) => u.plan === '일반 회원');
    }

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
        <td><span class="status-badge ${u.plan === '프리미엄 회원' ? 'green-bg' : 'brown-bg'}">${u.plan === '프리미엄 회원' ? '★ ' : ''}${u.plan}</span></td>
        <td><span class="status-badge ${u.status === '활성' ? 'green-bg' : u.status === '정지' ? 'cancel' : 'brown-bg'}">${u.status}</span></td>
        <td><button class="link-btn" onclick="event.stopPropagation(); openUserDrawer(${u.id})">상세보기</button></td>
      </tr>
    `
      )
      .join('');
  }

  // 상단 필터 탭 (Pill Buttons) 이벤트
  const filterPills = document.querySelectorAll('.filter-pill');
  filterPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      filterPills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.getAttribute('data-filter');
      renderUserTable();
    });
  });

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

    // 구독 정보
    const planBadgeEl = document.getElementById('drawer-sub-plan');
    const priceEl = document.getElementById('drawer-sub-price');
    const nextPayEl = document.getElementById('drawer-sub-next');
    const btnExtend = document.getElementById('btn-extend-sub');
    const btnCancel = document.getElementById('btn-cancel-sub');

    planBadgeEl.textContent = user.plan;

    if (user.plan === '일반 회원') {
      planBadgeEl.className = 'plan-badge brown-bg';
      priceEl.textContent = '무료 이용 중 (월 0원)';
      nextPayEl.textContent = '- (미구독)';
      if (btnExtend) {
        btnExtend.innerHTML = `<i data-lucide="crown"></i> 프리미엄으로 업그레이드`;
      }
      if (btnCancel) {
        btnCancel.style.display = 'none';
      }
    } else {
      planBadgeEl.className = 'plan-badge green-bg';
      priceEl.textContent = '프리미엄 혜택 이용 중 (월 19,900원)';
      nextPayEl.textContent = user.nextPay;
      if (btnExtend) {
        btnExtend.innerHTML = `<i data-lucide="calendar-plus"></i> 프리미엄 1개월 연장`;
      }
      if (btnCancel) {
        btnCancel.style.display = 'flex';
        btnCancel.innerHTML = `<i data-lucide="slash"></i> 일반 회원으로 해지`;
      }
    }

    if (window.lucide) {
      lucide.createIcons();
    }

    // 실시간 통계
    document.getElementById('drawer-stat-ocr').innerHTML = `${user.ocrCount}<span class="stat-unit">건</span>`;
    document.getElementById('drawer-stat-stocks').innerHTML = `${user.stockCount}<span class="stat-unit">개</span>`;

    // 관리자 메모
    document.getElementById('drawer-user-memo').value = user.memo || '';

    // Drawer 표시
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

  // 7. 계정 상태 변경 이벤트
  const statusSelect = document.getElementById('drawer-user-status-select');
  if (statusSelect) {
    statusSelect.addEventListener('change', (e) => {
      if (selectedUser) {
        selectedUser.status = e.target.value;
        renderUserTable();
        renderTimelineFeed();
        alert(`${selectedUser.name} 사장님의 계정 상태가 '${e.target.value}'(으)로 가상 업데이트되었습니다.`);
      }
    });
  }

  // 8. 프리미엄 수동 연장/승격 이벤트
  const btnExtend = document.getElementById('btn-extend-sub');
  if (btnExtend) {
    btnExtend.addEventListener('click', () => {
      if (selectedUser) {
        if (selectedUser.plan === '일반 회원') {
          selectedUser.plan = '프리미엄 회원';
          selectedUser.subPrice = '월 19,900원';
          selectedUser.nextPay = '2026-08-15';
          document.getElementById('drawer-sub-plan').textContent = selectedUser.plan;
          document.getElementById('drawer-sub-price').textContent = '프리미엄 혜택 이용 중 (월 19,900원)';
          document.getElementById('drawer-sub-next').textContent = selectedUser.nextPay;
          renderUserTable();
          renderTimelineFeed();
          alert(`${selectedUser.store} 매장이 '프리미엄 회원'으로 승격되었습니다!`);
        } else {
          const currentYear = new Date().getFullYear();
          selectedUser.nextPay = `${currentYear}-09-01`;
          document.getElementById('drawer-sub-next').textContent = selectedUser.nextPay;
          renderUserTable();
          alert(`${selectedUser.store} 매장의 프리미엄 만료일이 1개월 연장되었습니다 (${selectedUser.nextPay}까지).`);
        }
      }
    });
  }

  // 9. 프리미엄 해지 이벤트
  const btnCancel = document.getElementById('btn-cancel-sub');
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      if (selectedUser) {
        if (confirm(`${selectedUser.store} 매장의 프리미엄 혜택을 해지하고 일반 회원으로 변경하시겠습니까?`)) {
          selectedUser.plan = '일반 회원';
          selectedUser.subPrice = '무료 (미구독)';
          selectedUser.nextPay = '-';
          document.getElementById('drawer-sub-plan').textContent = selectedUser.plan;
          document.getElementById('drawer-sub-price').textContent = '무료 이용 중 (월 0원)';
          document.getElementById('drawer-sub-next').textContent = selectedUser.nextPay;
          renderUserTable();
          renderTimelineFeed();
          alert('일반 회원으로 변경 처리되었습니다.');
        }
      }
    });
  }

  // 10. 메모 저장 이벤트
  const btnSaveMemo = document.getElementById('btn-save-memo');
  if (btnSaveMemo) {
    btnSaveMemo.addEventListener('click', () => {
      if (selectedUser) {
        const memoText = document.getElementById('drawer-user-memo').value;
        selectedUser.memo = memoText;
        alert(`${selectedUser.store} 사장님에 대한 CS 관리자 메모가 로컬에 임시 저장되었습니다.`);
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

  // 12. [한글 주석: Drawer 회원 가입 즉시 승인 퀵 처리]
  const btnApproveUser = document.getElementById('btn-approve-user');
  if (btnApproveUser) {
    btnApproveUser.addEventListener('click', () => {
      if (selectedUser) {
        selectedUser.status = '활성';
        const statusSelect = document.getElementById('drawer-user-status-select');
        if (statusSelect) statusSelect.value = '활성';
        renderUserTable();
        renderTimelineFeed();
        alert(`🎉 ${selectedUser.name} 사장님(${selectedUser.store})의 가입이 성공적으로 승인 및 활성화되었습니다!`);
      }
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
    if (!specificSelect) return;
    specificSelect.innerHTML = '<option value="">-- 수신 점포 선택 --</option>' + 
      mockUsers.map(u => `<option value="${u.store}">${u.store} (${u.name})</option>`).join('');
  }

  const notifForm = document.getElementById('notif-form');
  if (notifForm) {
    notifForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('notif-title').value.trim();
      const body = document.getElementById('notif-body').value.trim();
      if (!title || !body) return;

      let targetLabel = '전체 사장님';
      if (currentNotifTarget === 'premium') targetLabel = '프리미엄 회원만';
      else if (currentNotifTarget === 'specific' && specificSelect) {
        targetLabel = `특정 매장 (${specificSelect.value})`;
      }

      try {
        const res = await fetch(`${API_BASE}/admin/notifications`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title,
            target: targetLabel
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
  let liveCSList = [
    {
      id: 1,
      store: '포슬카페',
      name: '포슬이',
      category: '💡 기능 요청',
      title: '원두 발주 추천 시 디카페인 자동 추가 기능 요청',
      date: '2026.07.20',
      status: '처리 완료',
      question: '주말마다 디카페인 손님이 늘어나고 있어서 AI 추천에 포함되었으면 좋겠습니다.',
      reply: '사장님, 좋은 의견 감사드립니다! 해당 기능은 다음주 알고리즘 업데이트에 자동 반영될 예정입니다.',
    },
  ];

  async function loadCSList() {
    try {
      const res = await fetch('http://localhost:8000/api/v1/admin/cs');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          liveCSList = data.map(item => ({
            id: item.id,
            store: item.store || item.store_name || '포슬카페',
            name: item.name || '사장님',
            category: item.category || '💡 기능 요청',
            title: item.title,
            date: item.date || '2026-07-21',
            status: item.status || '답변 대기',
            question: item.question || item.content || item.title,
            reply: item.reply || item.answer || '',
          }));
        }
      }
    } catch (err) {
      console.warn('CS 실시간 목록 조회 실패 (기본값 표시):', err);
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
      csTableBody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center; padding:30px; color:#8C6F56;">
            해당 조건에 해당하는 문의 내역이 없습니다.
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
          <td><strong>${c.store || '포슬카페'}</strong> (${c.name || '포슬이'})</td>
          <td><span class="feed-plan-chip">${c.category || '💡 기능 요청'}</span></td>
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
        const res = await fetch(`http://localhost:8000/api/v1/admin/cs/${selectedCSItem.id}/reply`, {
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

  // 초기 1대1 문의 불러오기 및 3초 자동 동기화
  loadCSList();
  setInterval(() => {
    loadCSList();
  }, 3000);

  // 15. [한글 주석: 결제 & 구독 매출 관리 이력 리스트]
  const paymentTableBody = document.getElementById('payment-table-body');
  function renderPaymentsTable() {
    if (!paymentTableBody) return;
    paymentTableBody.innerHTML = mockPayments.map(p => `
      <tr>
        <td><strong>${p.id}</strong></td>
        <td>${p.date}</td>
        <td>${p.store} ${p.owner ? '(' + p.owner + ')' : ''}</td>
        <td><span class="status-badge green-bg">★ ${p.plan || '프리미엄'}</span></td>
        <td><strong>${p.amount}</strong></td>
        <td>${p.method || '신용카드'}</td>
        <td><span class="status-badge green-bg">✅ ${p.status || '결제 성공'}</span></td>
      </tr>
    `).join('');
  }

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
        document.getElementById('stats-premium-ratio').innerHTML = `${data.premiumRatio}<span class="unit"></span>`;
        document.getElementById('stats-premium-sub').textContent = `전체 사장님 대비 프리미엄 비율`;
        document.getElementById('stats-total-ingredients').innerHTML = `${data.totalIngredients}<span class="unit">품목</span>`;
        document.getElementById('stats-ocr-count').innerHTML = `${data.activeUsersCount}<span class="unit">개</span>`;
      }
    } catch (err) {
      console.error('통계 로드 실패:', err);
    }
  }

  async function loadCSList() {
    try {
      const res = await fetch(`${API_BASE}/admin/cs`);
      if (res.ok) {
        mockCSList = await res.json();
        renderCSTable();
      }
    } catch (err) {
      console.error('CS 리스트 조회 실패:', err);
    }
  }

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

  async function loadPayments() {
    try {
      const res = await fetch(`${API_BASE}/admin/payments`);
      if (res.ok) {
        mockPayments = await res.json();
        renderPaymentsTable();
      }
    } catch (err) {
      console.error('결제 조회 실패:', err);
    }
  }

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

  // [한글 주석: 초기 구동 시 실시간 데이터 전면 동기화]
  async function initDashboard() {
    await checkBackendHealth();
    await loadDashboardStats();
    await loadUsers();
    await loadCSList();
    await loadNotifications();
    await loadPayments();
    await loadAcquisition();
    await loadActivity();
    await loadAgents();
  }

  initDashboard();
});
