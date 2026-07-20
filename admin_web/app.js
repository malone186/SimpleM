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

  // 3. 회원 데이터
  const mockUsers = [
    {
      id: 1,
      name: '포슬이',
      store: '포슬카페',
      email: 'owner@cafe.com',
      status: '활성',
      joined: '2026-07-01 10:15',
      plan: '프리미엄 회원',
      subPrice: '월 19,900원',
      nextPay: '2026-08-01',
      ocrCount: 14,
      stockCount: 28,
      memo: '초기 테스터 사장님 계정. 프리미엄 이용 중.',
    },
    {
      id: 2,
      name: '김철수',
      store: '블루보틀 강남',
      email: 'chulsoo@cafe.com',
      status: '활성',
      joined: '2026-07-03 14:20',
      plan: '프리미엄 회원',
      subPrice: '월 19,900원',
      nextPay: '2026-08-03',
      ocrCount: 45,
      stockCount: 62,
      memo: '강남점 매장. 프리미엄 결제 이용 중.',
    },
    {
      id: 3,
      name: '이영희',
      store: '성수 로스터스',
      email: 'young@cafe.com',
      status: '활성',
      joined: '2026-07-05 09:30',
      plan: '프리미엄 회원',
      subPrice: '월 19,900원',
      nextPay: '2026-08-05',
      ocrCount: 8,
      stockCount: 15,
      memo: '원두 큐레이션 및 프리미엄 전용 기능 활용.',
    },
    {
      id: 4,
      name: '박민수',
      store: '카페 민트',
      email: 'min@cafe.com',
      status: '활성',
      joined: '2026-07-07 16:45',
      plan: '일반 회원',
      subPrice: '무료 (미구독)',
      nextPay: '-',
      ocrCount: 19,
      stockCount: 34,
      memo: '일반 무료 이용 사장님.',
    },
    {
      id: 5,
      name: '최동현',
      store: '더드립 청담',
      email: 'choi@cafe.com',
      status: '대기',
      joined: '2026-07-10 11:10',
      plan: '일반 회원',
      subPrice: '무료 (미구독)',
      nextPay: '-',
      ocrCount: 0,
      stockCount: 5,
      memo: '서류 승인 대기 중.',
    },
    {
      id: 6,
      name: '정수진',
      store: '빈브라더스 판교',
      email: 'sujin@cafe.com',
      status: '활성',
      joined: '2026-07-12 18:00',
      plan: '프리미엄 회원',
      subPrice: '월 19,900원',
      nextPay: '2026-08-12',
      ocrCount: 22,
      stockCount: 40,
      memo: '프리미엄 이용 사장님.',
    },
    {
      id: 7,
      name: '강지훈',
      store: '메머드커피 신촌',
      email: 'kang@cafe.com',
      status: '활성',
      joined: '2026-07-14 13:25',
      plan: '일반 회원',
      subPrice: '무료 (미구독)',
      nextPay: '-',
      ocrCount: 6,
      stockCount: 18,
      memo: '일반 무료 회원.',
    },
    {
      id: 8,
      name: '윤아름',
      store: '컴포즈 서초',
      email: 'arum@cafe.com',
      status: '활성',
      joined: '2026-07-15 15:50',
      plan: '일반 회원',
      subPrice: '무료 (미구독)',
      nextPay: '-',
      ocrCount: 11,
      stockCount: 22,
      memo: '일반 무료 회원.',
    },
    {
      id: 9,
      name: '한상우',
      store: '텐퍼센트 혜화',
      email: 'han@cafe.com',
      status: '대기',
      joined: '2026-07-16 17:05',
      plan: '일반 회원',
      subPrice: '무료 (미구독)',
      nextPay: '-',
      ocrCount: 0,
      stockCount: 2,
      memo: '신규 회원 가입.',
    },
  ];

  let selectedUser = null;
  let currentFilter = 'all'; // 'all' | 'premium' | 'general'

  // 4. [한글 주석: 메인 대시보드 최근 가입 타임라인 피드 - 실시간 롤링 슬라이드 스트림]
  const recentFeedContainer = document.getElementById('recent-users-feed');
  let feedListIndex = 3; // 기본 3개 노출 후 다음 신규 가입 순번

  function renderTimelineFeed(highlightFirst = false) {
    if (!recentFeedContainer) return;

    // 전체 mockUsers에서 3개 선택 (feedListIndex 기준 롤링)
    const currentList = [];
    for (let i = 0; i < 3; i++) {
      const idx = (feedListIndex - 3 + i + mockUsers.length) % mockUsers.length;
      currentList.unshift(mockUsers[idx]); // 최신순 정렬
    }

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

  renderTimelineFeed();

  // [한글 주석: 4초마다 새로운 사장님이 가입되는 실시간 라이브 피드 롤링 연출]
  setInterval(() => {
    feedListIndex = (feedListIndex + 1) % mockUsers.length;
    renderTimelineFeed(true);
  }, 4000);

  // 5. [회원 관리] 탭 통합 사장님 테이블 렌더링
  const userTableBody = document.getElementById('user-table-body');
  function renderUserTable() {
    if (!userTableBody) return;

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

  renderUserTable();

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
        alert(`${selectedUser.name} 사장님의 계정 상태가 '${e.target.value}'(으)로 변경되었습니다.`);
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
        alert(`${selectedUser.store} 사장님에 대한 CS 관리자 메모가 저장되었습니다.`);
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

  const mockNotifHistory = [
    { id: 1, title: '[안내] 7월 AI 매출 예측 엔진 정기 업데이트', body: 'AI 매출 예측 엔진의 정확도가 향상된 모델로 업데이트되었습니다. 앱에서 확인해 보세요.', target: '전체 사장님', time: '2026-07-18 14:00' },
    { id: 2, title: '👑 프리미엄 회원 전용 1:1 세무 컨설팅 수신', body: '이번 달 결산 세무 보조 리포트가 완성되었습니다.', target: '프리미엄 회원만', time: '2026-07-15 10:30' },
    { id: 3, title: '[공지] 바코드 영수증 OCR 인식 속도 2배 개선', body: '영수증 촬영 후 자동 입력 속도가 더욱 빨라졌습니다.', target: '전체 사장님', time: '2026-07-10 09:15' },
  ];

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
          <span class="notif-history-time">${n.time}</span>
        </div>
        <div class="notif-history-body">${n.body}</div>
        <span class="notif-target-tag">수신: ${n.target}</span>
      </div>
    `
      )
      .join('');
  }
  renderNotifHistory();

  const notifForm = document.getElementById('notif-form');
  if (notifForm) {
    notifForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = document.getElementById('notif-title').value.trim();
      const body = document.getElementById('notif-body').value.trim();
      if (!title || !body) return;

      let targetLabel = '전체 사장님 (9명)';
      if (currentNotifTarget === 'premium') targetLabel = '👑 프리미엄 회원만 (4명)';
      else if (currentNotifTarget === 'specific' && specificSelect) {
        targetLabel = `특정 매장 (${specificSelect.value})`;
      }

      const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 16);
      mockNotifHistory.unshift({
        id: Date.now(),
        title,
        body,
        target: targetLabel,
        time: nowStr,
      });

      renderNotifHistory();
      document.getElementById('notif-title').value = '';
      document.getElementById('notif-body').value = '';
      alert(`📲 [발송 완료] ${targetLabel} 대상 사장님 전용 알림 메시지가 성공적으로 전달되었습니다!`);
    });
  }

  // 14. [한글 주석: CS / 1:1 문의 데이터 및 관리 모달]
  const mockCSList = [
    { id: 101, store: '포슬카페', name: '포슬이', category: '영수증 OCR', title: '바코드가 약간 구겨져도 인식이 잘 되나요?', date: '2026-07-19 15:30', status: '답변 대기', question: '영수증 OCR 촬영 시 바코드가 약간 구겨져도 제대로 인식이 되는지 궁금합니다!', answer: '' },
    { id: 102, store: '블루보틀 강남', name: '김철수', category: '결제/구독', title: '프리미엄 요금제 영수증 발행 요청', date: '2026-07-18 11:20', status: '답변 대기', question: '7월분 프리미엄 회원 구독료에 대한 사업자 증빙 영수증을 이메일로 받아볼 수 있을까요?', answer: '' },
    { id: 103, store: '성수 로스터스', name: '이영희', category: '원두 큐레이션', title: '에티오피아 원두 산미 추천 필터 문의', date: '2026-07-16 17:45', status: '처리 완료', question: '원두 취향 큐레이터에서 약배전 산미 위주 원두 목록을 추가해 주실 수 있나요?', answer: '안녕하세요 이영희 사장님! 원두 취향 큐레이터에 산미/가공방식 필터가 추가되었습니다.' },
    { id: 104, store: '카페 민트', name: '박민수', category: '앱 사용법', title: '알바 스케줄 자동 생성 추천 활용법', date: '2026-07-14 09:10', status: '처리 완료', question: '주말 피크 타임에 알바 1명 추가 추천이 떠서 반영했습니다. 감사합니다!', answer: '감사합니다 사장님! AI 스케줄러가 매장 매출 추이를 분석해 피크타임을 자동 계산합니다.' },
    { id: 105, store: '더드립 청담', name: '최동현', category: '계정/승인', title: '매장 가입 승인 서류 제출 완료 문의', date: '2026-07-12 16:30', status: '처리 완료', question: '사업자등록증 서류 등록을 마쳤습니다. 승인 부탁드립니다.', answer: '사장님, 서류 확인이 정상 완료되어 승인 처리해 드렸습니다!' }
  ];

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
        <td><span class="feed-plan-chip">${c.category}</span></td>
        <td>${c.title}</td>
        <td>${c.date}</td>
        <td><span class="status-badge ${c.status === '처리 완료' ? 'green-bg' : 'amber-bg pulse'}">${c.status === '처리 완료' ? '✅ ' : '⏳ '}${c.status}</span></td>
        <td><button class="link-btn" onclick="event.stopPropagation(); openCSModal(${c.id})">${c.status === '답변 대기' ? '답변하기' : '답변확인'}</button></td>
      </tr>
    `).join('');
  }
  renderCSTable();

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
    document.getElementById('cs-modal-question').textContent = item.question;
    document.getElementById('cs-answer-input').value = item.answer || '';

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
    btnSendCSAnswer.addEventListener('click', () => {
      if (!selectedCSItem) return;
      const answerText = document.getElementById('cs-answer-input').value.trim();
      if (!answerText) {
        alert('사장님께 전송할 답변 내용을 입력해 주세요!');
        return;
      }
      selectedCSItem.answer = answerText;
      selectedCSItem.status = '처리 완료';
      renderCSTable();
      if (csModalOverlay) csModalOverlay.classList.remove('active');
      alert(`💌 [답변 전달 완료] ${selectedCSItem.store} 사장님 앱 1:1 문의 답변으로 전송되었습니다!`);
    });
  }

  // 15. [한글 주석: 결제 & 구독 매출 관리 이력 리스트]
  const mockPayments = [
    { id: 'PAY-2026-0701', date: '2026-07-01 10:15', store: '포슬카페 (owner@cafe.com)', plan: '프리미엄 회원 (월정액)', amount: '₩19,900', method: '신용카드 (현대 8492)', status: '결제 성공' },
    { id: 'PAY-2026-0703', date: '2026-07-03 14:20', store: '블루보틀 강남 (chulsoo@cafe.com)', plan: '프리미엄 회원 (월정액)', amount: '₩19,900', method: '카카오페이', status: '결제 성공' },
    { id: 'PAY-2026-0705', date: '2026-07-05 09:30', store: '성수 로스터스 (young@cafe.com)', plan: '프리미엄 회원 (월정액)', amount: '₩19,900', method: '신용카드 (신한 1039)', status: '결제 성공' },
    { id: 'PAY-2026-0712', date: '2026-07-12 18:00', store: '빈브라더스 판교 (sujin@cafe.com)', plan: '프리미엄 회원 (월정액)', amount: '₩19,900', method: '네이버페이', status: '결제 성공' }
  ];

  const paymentTableBody = document.getElementById('payment-table-body');
  function renderPaymentsTable() {
    if (!paymentTableBody) return;
    paymentTableBody.innerHTML = mockPayments.map(p => `
      <tr>
        <td><strong>${p.id}</strong></td>
        <td>${p.date}</td>
        <td>${p.store}</td>
        <td><span class="status-badge green-bg">★ ${p.plan}</span></td>
        <td><strong>${p.amount}</strong></td>
        <td>${p.method}</td>
        <td><span class="status-badge green-bg">✅ ${p.status}</span></td>
      </tr>
    `).join('');
  }
  renderPaymentsTable();
});
