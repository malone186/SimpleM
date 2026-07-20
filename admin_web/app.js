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
  let currentCSFilter = 'all';
  const csTableBody = document.getElementById('cs-table-body');

  function renderCSTable() {
    if (!csTableBody) return;
    let list = mockCSList;
    if (currentCSFilter === 'waiting') list = mockCSList.filter(c => c.status === '답변 대기');
    else if (currentCSFilter === 'done') list = mockCSList.filter(c => c.status === '처리 완료');

    csTableBody.innerHTML = list.map(c => `
      <tr class="clickable-row" onclick="openCSModal(${c.id})">
        <td>#CS-${c.id}</td>
        <td><strong>${c.store}</strong> (${c.name})</td>
        <td><span class="feed-plan-chip">${c.category || '기타 문의'}</span></td>
        <td>${c.title}</td>
        <td>${c.date}</td>
        <td><span class="status-badge ${c.status === '처리 완료' ? 'green-bg' : 'amber-bg pulse'}">${c.status === '처리 완료' ? '✅ ' : '⏳ '}${c.status}</span></td>
        <td><button class="link-btn" onclick="event.stopPropagation(); openCSModal(${c.id})">${c.status === '답변 대기' ? '답변하기' : '답변확인'}</button></td>
      </tr>
    `).join('');
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
    const item = mockCSList.find(c => c.id === id);
    if (!item) return;
    selectedCSItem = item;

    document.getElementById('cs-modal-id').textContent = `#CS-${item.id}`;
    document.getElementById('cs-modal-store').textContent = `${item.store} (${item.name} 사장님)`;
    document.getElementById('cs-modal-date').textContent = item.date;
    document.getElementById('cs-modal-question').textContent = item.question || item.content;
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
          alert(`💌 [답변 전달 완료] ${selectedCSItem.store} 사장님께 답변이 전달되었습니다!`);
          if (csModalOverlay) csModalOverlay.classList.remove('active');
          await loadCSList();
        }
      } catch (err) {
        console.error(err);
        alert('CS 답변 등록 실패');
      }
    });
  }

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

  // [한글 주석: 초기 구동 시 실시간 데이터 전면 동기화]
  async function initDashboard() {
    await checkBackendHealth();
    await loadDashboardStats();
    await loadUsers();
    await loadCSList();
    await loadNotifications();
    await loadPayments();
  }

  initDashboard();
});
