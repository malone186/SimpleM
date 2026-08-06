// 재고 (프론트 A) — PRD ERP-4/7, AI-2: 재고 조회 + 직접 등록 + 안전재고 알림 + OCR 입고 확인
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { ActivityIndicator, Alert, Animated, Platform, RefreshControl, ScrollView, StatusBar, StyleSheet, Text, TextInput, View, LayoutAnimation, UIManager } from 'react-native';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

import { useNavigation, useRoute } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import { useTranslation } from '../../i18n/translations';
import CameraCaptureModal from '../../components/CameraCaptureModal';
import { FadeInUp, PressableScale } from '../../components/motion';
import Svg, { Circle, Defs, FeGaussianBlur, Filter, LinearGradient, Path, Stop } from 'react-native-svg';
import Brew from '../../components/brew/Brew';
import { confirmDialog, toast } from '../../components/toast';
import { Badge, Button, Card, ProgressBar, SectionTitle } from '../../components/ui';
import { SwipeDownModal } from '../../components/ui/SwipeDownModal';
import { preloadInterstitial, showAdWhile } from '../../lib/ads';
import { API_BASE_URL } from '../../lib/api/client';
import { adjustStock, createIngredient, listStocks, StockItem } from '../../lib/api/inventory';
import { confirmOcrDocument, listOcrDocuments, rejectOcrDocument, uploadOcrImage, OcrDocument, updateOcrDocument, OcrItem, type UploadAsset } from '../../lib/api/ocr';
import { colors, typography } from '../../theme';
import { s, useResponsive, useTopInset } from '../../theme/responsive';

const TARGET_LABEL: Record<string, string> = {
  inventory_inbound: '재고 입고',
  expense: '지출',
  sales: '매출',
};

const notify = (title: string, message: string) => toast(title, message);

// [한글 주석] 상단 상태바 여백은 useTopInset() 훅이 기기 실측값으로 계산한다.
// 예전 고정값(ios: 56)은 노치 없는 SE에서 과했고 다이나믹 아일랜드(59pt)에서는 모자랐다.

// [한글 주석] 재고 카테고리 정의
const CATEGORIES = [
  { id: 'all', label: '전체' },
  { id: 'bean', label: '☕ 원두·커피' },
  { id: 'milk', label: '🥛 우유·유제품' },
  { id: 'syrup', label: '🍯 시럽·파우더' },
  { id: 'cup', label: '🥤 컵·부자재' },
  { id: 'etc', label: '📦 기타' },
];

function getCategory(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('원두') || n.includes('커피') || n.includes('에스프레소') || n.includes('콜롬비아') || n.includes('에티오피아') || n.includes('디카페인') || n.includes('예가체프')) return 'bean';
  if (n.includes('우유') || n.includes('유제품') || n.includes('크림') || n.includes('치즈') || n.includes('연유') || n.includes('버터') || n.includes('아이스크림')) return 'milk';
  if (n.includes('시럽') || n.includes('파우더') || n.includes('초코') || n.includes('카라멜') || n.includes('바닐라') || n.includes('소스') || n.includes('퓨레') || n.includes('녹차') || n.includes('홍차') || n.includes('베이스')) return 'syrup';
  if (n.includes('컵') || n.includes('종이컵') || n.includes('아이스컵') || n.includes('빨대') || n.includes('홀더') || n.includes('뚜껑') || n.includes('캐리어') || n.includes('휴지') || n.includes('비닐') || n.includes('포장') || n.includes('용기') || n.includes('소모품')) return 'cup';
  return 'etc';
}

// 초안 편집용 행 — 타이핑 중간 상태("1." 등)를 허용하려고 문자열로 들고 저장 시 숫자로 변환
type EditRow = { name: string; qty: string; unit: string; price: string };

export default function InventoryScreen() {
  // [한글 주석: 다국어 번역 훅 연동 — 영문/한글 화면 가공]
  const { t, language } = useTranslation();
  const { token } = useAuth();
  const navigation = useNavigation<any>();
  // [한글 주석] 기기 상태바 높이 실측 + 화면 급수 판정 (플립 커버 화면에서는 마스코트를 줄인다)
  const topInset = useTopInset();
  const { isCompact, isXS, isWide, contentMaxWidth } = useResponsive();
  const [stocks, setStocks] = useState<StockItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all'); // [한글 주석] 카테고리 필터 상태
  const [drafts, setDrafts] = useState<OcrDocument[]>([]);
  const [scanning, setScanning] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false); // 웹 인앱 카메라 모달
  const [sourceSheetOpen, setSourceSheetOpen] = useState(false); // 업로드 소스(촬영/앨범/PDF) 선택 시트
  const [actingDocId, setActingDocId] = useState<string | null>(null); // 반려/확정 요청 진행 중인 초안 ID

  // [한글 주석] 영수증(명세서) 초안 수정 상태 관리 변수들
  const [editingDocId, setEditingDocId] = useState<string | null>(null); // 현재 수정 중인 영수증 초안의 ID
  const [editingRows, setEditingRows] = useState<EditRow[]>([]); // 편집 중인 품목들 (기존 품목도 값 수정 가능)
  const [isSavingDraft, setIsSavingDraft] = useState(false); // 수정 사항 저장 중 로딩 여부

  // [한글 주석: 카테고리 드롭다운 아코디언 창의 열림/닫힘 상태]
  const [isCategoryOpen, setIsCategoryOpen] = useState(false);

  // [한글 주석: 드롭다운이 쫀득하게 톡 펼쳐지도록 도와주는 스프링 트랜지션]
  const springTransition = () => {
    LayoutAnimation.configureNext({
      duration: 320,
      create: { type: LayoutAnimation.Types.spring, property: LayoutAnimation.Properties.opacity, springDamping: 0.8 },
      update: { type: LayoutAnimation.Types.spring, springDamping: 0.8 },
      delete: { type: LayoutAnimation.Types.spring, property: LayoutAnimation.Properties.opacity, springDamping: 0.8 }
    });
  };

  // [한글 주석] 새 품목 수동 추가를 위한 인풋 상태 관리 변수들
  const [newItemName, setNewItemName] = useState(''); // 추가할 품목명
  const [newItemQty, setNewItemQty] = useState(''); // 추가할 수량
  const [newItemUnit, setNewItemUnit] = useState('개'); // 추가할 단위
  const [newItemPrice, setNewItemPrice] = useState(''); // 추가할 단가

  // 직접 등록 폼
  const [formOpen, setFormOpen] = useState(false);
  const [fName, setFName] = useState('');
  const [fUnit, setFUnit] = useState('');
  const [fPrice, setFPrice] = useState('');
  const [fQty, setFQty] = useState('');
  const [saving, setSaving] = useState(false);

  // 기존 재고 직접 입고/차감
  const [adjustId, setAdjustId] = useState<number | null>(null);
  const [adjustQty, setAdjustQty] = useState('');

  const loadStocks = useCallback(() => {
    if (!token) return;
    listStocks(token).then(setStocks).catch(() => {});
  }, [token]);

  const loadDrafts = useCallback(() => {
    // 초안은 매장(계정)별로 격리 — 로그아웃/계정 전환 시 이전 계정 초안이 남지 않게 비운다
    if (!token) { setDrafts([]); return; }
    listOcrDocuments('draft', token).then(setDrafts).catch(() => {});
  }, [token]);

  // 헤더 시트에서 아래로 당겨 새로고침 — Screen 래퍼를 걷어낸 대신 재고·초안을 다시 부른다
  const [refreshing, setRefreshing] = useState(false);
  const onHeaderRefresh = useCallback(() => {
    setRefreshing(true);
    loadStocks();
    loadDrafts();
    setTimeout(() => setRefreshing(false), 650);
  }, [loadStocks, loadDrafts]);

  useEffect(() => {
    loadStocks();
    loadDrafts();
  }, [loadStocks, loadDrafts]);

  // OCR 대기 시간에 광고를 태우려면 미리 받아둬야 한다 (로드에 1~3초).
  // 실패하면 광고 없이 기존 흐름대로 동작한다.
  useEffect(() => {
    preloadInterstitial();
  }, []);

  // 재료 직접 등록 → 같은 이름의 재료가 이미 있으면 새로 만들지 않고 기존 재고에 추가 입고
  const registerIngredient = async () => {
    if (!token) return notify('로그인 필요', '재료 등록은 로그인 후 가능합니다.');
    if (!fName.trim() || !fUnit.trim()) return notify('입력 확인', '재료명과 단위는 필수입니다.');
    setSaving(true);
    try {
      const name = fName.trim();
      const qty = Number(fQty) || 0;

      // 화면의 stocks는 오래됐을 수 있으므로 최신 목록으로 중복을 확인한다
      const latest = await listStocks(token).catch(() => stocks);
      const existing = latest.find((s) => s.name === name);

      if (existing && qty <= 0) {
        notify('이미 등록된 재료', `${existing.name}은(는) 이미 등록돼 있어요. 초기 수량을 입력하면 기존 재고에 추가 입고돼요.`);
        return;
      }

      if (existing) {
        await adjustStock(token, { ingredient_id: existing.ingredient_id, quantity_change: qty, description: '직접 등록 추가 입고' });
        notify('입고 완료', `이미 등록된 재료라 ${existing.name} 재고에 ${qty}${existing.unit}을(를) 추가했어요.`);
      } else {
        const ing = await createIngredient(token, {
          name,
          unit: fUnit.trim(),
          current_price: Number(fPrice) || 0,
        });
        if (qty > 0) {
          await adjustStock(token, { ingredient_id: ing.id, quantity_change: qty, description: '직접 등록 초기 수량' });
        }
        notify('등록 완료', `${ing.name} 재료가 등록됐어요.`);
      }

      setFName(''); setFUnit(''); setFPrice(''); setFQty('');
      setFormOpen(false);
      loadStocks();
    } catch (e) {
      notify('등록 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  // 업로드 소스는 세 가지다. 거래처 명세서는 사진보다 이메일 PDF로 오는 일이 더 많아서
  // (사장님 피드백: "발주하는 거 거의 이메일로 명세서 오니깐") 파일 선택이 사실상 주 경로다.
  // PDF는 텍스트가 살아 있어 사진보다 인식 정확도도 높다.
  type OcrSource = 'camera' | 'album' | 'file';

  // 업로드는 소스가 무엇이든 여기 한 곳으로 모인다 (촬영·앨범·파일·웹 카메라)
  const uploadAsset = async (asset: UploadAsset) => {
    setScanning(true);
    try {
      // 인식이 도는 동안 전면 광고를 띄우고, 광고가 닫히면 결과가 바로 나온다.
      // 광고가 없으면(웹·미로드·노출 간격) 지금까지와 똑같이 결과만 기다린다.
      const doc = await showAdWhile(uploadOcrImage(asset, token));
      setDrafts((prev) => [doc, ...prev]);
      const secs = doc.elapsed_sec != null ? ` (${doc.elapsed_sec}초)` : '';
      notify('인식 완료' + secs, `${doc.result.items.length}개 품목을 인식했어요. 내용을 확인하고 반영하세요.`);
    } catch (e) {
      notify('인식 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setScanning(false);
    }
  };

  const pickFromFiles = async (): Promise<UploadAsset | null> => {
    // expo-document-picker는 네이티브 모듈이라 구버전 앱에는 없을 수 있다. 정적 import로
    // 올리면 그런 빌드에서 화면 진입만으로 앱이 죽으므로 필요할 때만 안전하게 불러온다.
    let DocumentPicker: any;
    try {
      DocumentPicker = require('expo-document-picker');
    } catch {
      notify('파일 선택을 쓸 수 없어요', '이 버전 앱에는 파일 선택 기능이 없어요. 앱을 업데이트하거나 사진 촬영·앨범을 이용해 주세요.');
      return null;
    }
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (res.canceled || !res.assets?.length) return null;
    const a = res.assets[0];
    return { uri: a.uri, mimeType: a.mimeType ?? null, fileName: a.name ?? null };
  };

  const runOcr = async (source: OcrSource) => {
    if (scanning) return;
    try {
      let asset: UploadAsset | null = null;

      if (source === 'file') {
        asset = await pickFromFiles();
      } else if (source === 'camera' && Platform.OS === 'web') {
        // 웹은 OS 카메라 앱을 띄울 수 없어 앱 안에 카메라 화면을 연다.
        // 실제 업로드는 onCapture 콜백(uploadCaptured)에서 이어진다.
        setCameraOpen(true);
        return;
      } else {
        // quality 0.6: 서버가 어차피 1600px대로 축소해 인식하므로 화질 손해 없이
        // 업로드 용량(12MP 기준 수 MB)을 줄여 모바일 회선에서 전송 시간을 아낀다
        let picked: ImagePicker.ImagePickerResult;
        if (source === 'camera') {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) {
            notify('카메라 권한이 필요해요', '설정에서 카메라 권한을 허용하거나 앨범·파일에서 골라 주세요.');
            return;
          }
          picked = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.6 });
        } else {
          picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
        }
        if (picked.canceled || !picked.assets?.length) return;
        const a = picked.assets[0];
        asset = { uri: a.uri, mimeType: a.mimeType ?? null, fileName: a.fileName ?? null };
      }

      if (!asset) return;
      await uploadAsset(asset);
    } catch (e) {
      notify('인식 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  // 시트에서 소스를 고르면 시트를 먼저 닫고 피커를 띄운다.
  // 바로 띄우면 iOS에서 RN 모달과 OS 카메라/파일 창이 겹쳐 아무것도 안 뜨는 일이 있어
  // 닫힘 애니메이션(약 250ms)이 끝난 뒤로 한 틱 미룬다.
  const chooseSource = (source: OcrSource) => {
    setSourceSheetOpen(false);
    setTimeout(() => runOcr(source), 280);
  };

  // 문서 종류별 확정 대상 — 매입 명세서는 재고 입고, 영수증은 지출, 일마감표는 판매 기록
  const confirmTargetOf = (doc: OcrDocument) => doc.suggested_target ?? 'inventory_inbound';
  const CONFIRM_LABEL = { inventory_inbound: '재고 반영', expense: '지출 반영', sales: '판매 반영' } as const;

  // OCR 확정 → 대상 시스템 반영(재고/지출/판매) → 재고 현황 즉시 갱신 (실시간 연동)
  const confirm = async (doc: OcrDocument) => {
    if (actingDocId) return; // 처리 중 중복 탭 방지 (이중 재고 반영·409 예방)
    setActingDocId(doc.id);
    try {
      const res = await confirmOcrDocument(doc.id, confirmTargetOf(doc), token);
      setDrafts((prev) => prev.filter((d) => d.id !== doc.id));
      loadStocks();
      notify('확정 완료', res.message);
    } catch (e) {
      notify('확정 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setActingDocId(null);
    }
  };

  const reject = async (doc: OcrDocument) => {
    if (actingDocId) return; // 처리 중 중복 탭 방지
    setActingDocId(doc.id);
    try {
      await rejectOcrDocument(doc.id, token);
      setDrafts((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (e) {
      notify('반려 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setActingDocId(null);
    }
  };

  // [한글 주석] 영수증 초안의 품목을 수정하기 위해 편집 모드를 활성화하고 데이터를 복사합니다.
  // 기존 품목도 값을 고칠 수 있도록 각 품목을 편집 가능한 행(문자열 입력값)으로 변환합니다.
  const startEditing = (doc: OcrDocument) => {
    setEditingDocId(doc.id);
    setEditingRows(doc.result.items.map((i) => ({
      name: i.name,
      qty: i.quantity != null ? String(i.quantity) : '',
      unit: i.unit ?? '개',
      price: i.unit_price != null ? String(i.unit_price) : '',
    })));
    setNewItemName('');
    setNewItemQty('');
    setNewItemUnit('개');
    setNewItemPrice('');
  };

  // [한글 주석] 영수증 수정을 취소하고 입력 중이던 임시 폼 값을 비웁니다.
  const cancelEditing = () => {
    setEditingDocId(null);
    setEditingRows([]);
  };

  // [한글 주석] 편집 중인 품목 한 줄의 특정 칸(이름/수량/단위/단가)을 갱신합니다.
  const updateRow = (index: number, patch: Partial<EditRow>) => {
    setEditingRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  // [한글 주석] 수정 화면에서 새 품목을 직접 적어 목록에 추가합니다.
  const handleAddItem = () => {
    if (!newItemName.trim()) {
      return notify('입력 확인', '추가할 재료명을 입력해 주세요.');
    }
    const qty = Number(newItemQty);
    if (isNaN(qty) || qty <= 0) {
      return notify('입력 확인', '올바른 수량을 입력해 주세요.');
    }

    setEditingRows((prev) => [...prev, {
      name: newItemName.trim(),
      qty: newItemQty,
      unit: newItemUnit.trim() || '개',
      price: newItemPrice,
    }]);

    // 입력창 초기화
    setNewItemName('');
    setNewItemQty('');
    setNewItemPrice('');
  };

  // [한글 주석] 영수증 품목 중 잘못 입력되었거나 인식 오류가 난 한 줄을 목록에서 제거합니다.
  const handleDeleteItem = (index: number) => {
    setEditingRows((prev) => prev.filter((_, i) => i !== index));
  };

  // [한글 주석] 수정한 영수증 품목들을 서버(DB)에 저장하여 영구 보존하고 연동 상태를 새로고침합니다.
  const saveEditing = async (docId: string) => {
    if (editingRows.some((r) => !r.name.trim())) {
      return notify('입력 확인', '품목명이 비어 있는 항목이 있어요. 채우거나 삭제해 주세요.');
    }
    // 문자열 입력값을 숫자로 변환 (빈칸은 '미인식'으로 저장, 합계는 수량×단가 자동 계산)
    const items: OcrItem[] = editingRows.map((r) => {
      const qty = r.qty.trim() === '' ? null : Number(r.qty);
      const price = r.price.trim() === '' ? null : Number(r.price);
      const validQty = qty != null && Number.isFinite(qty) ? qty : null;
      const validPrice = price != null && Number.isFinite(price) ? price : null;
      return {
        name: r.name.trim(),
        spec: null,
        quantity: validQty,
        unit: r.unit.trim() || '개',
        unit_price: validPrice,
        amount: validQty != null && validPrice != null ? validQty * validPrice : null,
        warnings: [],
      };
    });

    setIsSavingDraft(true);
    try {
      await updateOcrDocument(docId, { items }, token);
      notify('저장 완료', '영수증 인식 내역이 정상적으로 업데이트되었습니다.');
      loadDrafts();
      setEditingDocId(null);
    } catch (e) {
      notify('저장 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    } finally {
      setIsSavingDraft(false);
    }
  };

  // 기존 재고 수량 직접 조정 (입고=+, 차감=-)
  const applyAdjust = async (s: StockItem, sign: 1 | -1) => {
    if (!token) return notify('로그인 필요', '재고 조정은 로그인 후 가능합니다.');
    const qty = Number(adjustQty);
    if (!qty || qty <= 0) return notify('입력 확인', '0보다 큰 수량을 입력하세요.');
    try {
      await adjustStock(token, {
        ingredient_id: s.ingredient_id,
        quantity_change: sign * qty,
        description: sign > 0 ? '직접 입고' : '직접 차감',
      });
      setAdjustId(null);
      setAdjustQty('');
      loadStocks();
      notify('반영 완료', `${s.name} ${sign > 0 ? '+' : '−'}${qty}${s.unit} 반영했어요.`);
    } catch (e) {
      notify('조정 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
    }
  };

  // 재고(재료) 삭제 — 확인 후 DELETE. 재고·레시피 cascade 정리
  const removeStock = (s: StockItem) => {
    confirmDialog(`'${s.name}'을(를) 삭제할까요? 재고·레시피에서도 함께 제거됩니다.`, {
      confirmLabel: '삭제',
      destructive: true,
      onConfirm: async () => {
        if (!token) return notify('로그인 필요', '다시 로그인해 주세요.');
        try {
          const res = await fetch(`${API_BASE_URL}/api/v1/inventory/ingredients/${s.ingredient_id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`삭제 실패 (${res.status})`);
          loadStocks();
          notify('삭제 완료', `${s.name}을(를) 삭제했어요.`);
        } catch (e) {
          notify('삭제 실패', e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요.');
        }
      },
    });
  };

  // [한글 주석] 선택된 카테고리에 해당하는 재고 항목만 필터링합니다.
  const filteredStocks = useMemo(() => {
    if (selectedCategory === 'all') return stocks;
    return stocks.filter((s) => getCategory(s.name) === selectedCategory);
  }, [stocks, selectedCategory]);

  // ── 알림에서 넘어온 품목으로 자동 이동 ─────────────────────────────
  // "재고 부족" 알림을 눌러 들어왔는데 그 재료가 목록 어딘가에 묻혀 있으면
  // 알림을 누른 의미가 없다. 카테고리 필터에 가려 있으면 필터부터 풀고,
  // 해당 카드로 스크롤한 뒤 잠깐 강조해 눈에 띄게 한다.
  const route = useRoute<any>();
  const scrollRef = useRef<any>(null);
  const cardY = useRef<Record<number, number>>({});
  const [focusId, setFocusId] = useState<number | null>(null);
  // 같은 요청을 두 번 처리하지 않도록 표시해 둔다 (필터를 풀면 이 효과가 다시 돈다)
  const handledFocus = useRef<string>('');

  // 푸시 알림으로 들어오면 값이 문자열("12")이고, 앱 안에서 넘기면 숫자(12)다.
  // 숫자로 통일하지 않으면 아래 === 비교가 조용히 어긋나 아무 카드도 못 찾는다.
  const rawFocus = route.params?.focusIngredientId as number | string | undefined;
  const focusParam = Number(rawFocus) || undefined;
  const focusTs = route.params?.ts as number | undefined;

  useEffect(() => {
    if (!focusParam || stocks.length === 0) return;
    const key = `${focusParam}:${focusTs ?? ''}`;
    if (handledFocus.current === key) return;

    const target = stocks.find((s) => s.ingredient_id === focusParam);
    if (!target) return; // 그 사이 지워진 재료 — 목록만 보여주고 끝낸다
    handledFocus.current = key;

    // 필터에 가려져 있으면 먼저 푼다. 풀지 않으면 스크롤할 카드가 아예 없다.
    setSelectedCategory((prev) =>
      prev !== 'all' && getCategory(target.name) !== prev ? 'all' : prev
    );
    setFocusId(focusParam);

    // 목록이 다시 그려져 위치가 잡힌 뒤에 좌표를 읽어야 한다
    const scrollTimer = setTimeout(() => {
      const y = cardY.current[focusParam];
      if (y != null) scrollRef.current?.scrollTo({ y: Math.max(0, y - 90), animated: true });
    }, 380);
    // 강조는 잠깐만 — 계속 켜 두면 그냥 다른 색 카드로 보인다
    const clearTimer = setTimeout(() => setFocusId(null), 3200);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearTimer);
    };
  }, [focusParam, focusTs, stocks]);

  // 스크롤에 따라 브라운 헤더가 천천히 올라가며 투명해지는 패럴럭스+페이드 (홈 화면과 동일)
  const scrollY = useRef(new Animated.Value(0)).current;
  const headerTranslate = scrollY.interpolate({ inputRange: [0, 300], outputRange: [0, 140], extrapolateLeft: 'clamp' });
  const headerOpacity = scrollY.interpolate({ inputRange: [0, 180], outputRange: [1, 0.35], extrapolate: 'clamp' });

  return (
    <View style={styles.brownRoot}>
      {/* [딥브라운 오로라 배경] 관리 탭과 동일 — 상단 딥브라운에서 하단 크림으로 녹아든다 */}
      <View style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%" preserveAspectRatio="none">
          <Defs>
            <LinearGradient id="invAurora" x1="0%" y1="0%" x2="0%" y2="100%">
              <Stop offset="0%" stopColor="#1E1612" />
              <Stop offset="35%" stopColor="#251C17" />
              <Stop offset="70%" stopColor="#6E5544" stopOpacity="0.35" />
              <Stop offset="100%" stopColor={colors.creamSand} />
            </LinearGradient>
            <Filter id="invGlow" x="-50%" y="-50%" width="200%" height="200%">
              <FeGaussianBlur stdDeviation="70" />
            </Filter>
          </Defs>
          <Path d="M0 0 H2000 V2000 H0 Z" fill="url(#invAurora)" />
          <Circle cx="85%" cy="12%" r="140" fill="#E28257" filter="url(#invGlow)" opacity="0.25" />
          <Circle cx="15%" cy="22%" r="130" fill="#C29D7A" filter="url(#invGlow)" opacity="0.2" />
          <Circle cx="60%" cy="4%" r="120" fill="#88BCB5" filter="url(#invGlow)" opacity="0.16" />
        </Svg>
      </View>

      {/* 헤더를 스크롤 안에 두고, 스크롤 시 천천히 위로+페이드 (홈 화면과 동일) */}
      <Animated.ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onHeaderRefresh}
            tintColor={colors.mochaBrown}
            colors={[colors.pointOrange]}
          />
        }
      >
        {/* 브라운 헤더 — 스크롤 시 패럴럭스(천천히 위로) + 페이드 */}
        <Animated.View style={{ transform: [{ translateY: headerTranslate }], opacity: headerOpacity }}>
          {/* [한글 주석] 상태바 여백은 기기 실측 inset — 노치·펀치홀·플립 커버 화면 모두 대응 */}
          <View style={[styles.brownHeader, { paddingTop: topInset }]}>
            <View style={styles.brownHeaderLeft}>
              <View>
                <Text style={styles.brownHeaderTitle}>{t('inventoryTitle')}</Text>
                <Text style={styles.brownHeaderSub}>{t('inventorySubtitle')}</Text>
              </View>
            </View>
            <View style={styles.brownHeaderRight}>
              {/* welcome 일러스트는 clipboard(317)보다 프레임 여백이 커(380) 작아 보인다 —
                  캐릭터 크기를 관리 탭과 맞추려고 프레임 비율(380/317)만큼 키운다 */}
              {/* [한글 주석] 좁은 화면에서는 마스코트가 제목을 밀어내므로 단계적으로 줄인다 */}
              <Brew mood="serving" size={isXS ? 84 : isCompact ? 112 : s(144)} />
            </View>
          </View>
        </Animated.View>

        {/* 둥근 크림 시트 — 콘텐츠가 위로 올라오며 헤더를 덮는다 */}
        {/* [한글 주석] 탭 바는 화면 아래 별도 영역이라 겹치지 않는다 — 하단은 시트 기본 여백(24)만 사용 */}
        <View
          style={[
            styles.brownSheet,
            // [한글 주석] 폴드 펼침에서 카드가 가로로 늘어지지 않게 폭 제한 + 가운데 정렬
            isWide && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' },
          ]}
        >
          {/* [한글 주석: 상단 관리 & 입고 연관 카드 그룹 — 8px 밀착 간격으로 유기적 배치] */}
          <View style={{ gap: 8 }}>
            {/* 메뉴·레시피 관리 진입 */}
            <PressableScale style={styles.menuNav} onPress={() => navigation.navigate('Menu')} to={0.97}>
              <View style={styles.menuNavIcon}>
                <Ionicons name="cafe-outline" size={20} color={colors.espressoBrown} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.menuNavTitle}>{t('menuMgmtTitle')}</Text>
                <Text style={styles.menuNavSub}>{t('menuMgmtSub')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown} />
            </PressableScale>

            {/* OCR 입고 — 카드를 누르면 소스 선택 시트(촬영/앨범/PDF)가 열린다 */}
            <Card>
              <PressableScale
                style={styles.ocrHead}
                onPress={() => setSourceSheetOpen(true)}
                disabled={scanning}
                to={0.98}
              >
                <View style={styles.ocrHeadIcon}>
                  <Ionicons name="scan-outline" size={20} color={colors.pointOrange} />
                </View>
                <View style={{ flex: 1 }}>
                  <SectionTitle>{language === 'en' ? 'Statement OCR Inbound' : '명세서 자동 입고'}</SectionTitle>
                  <Text style={styles.hint}>
                    {scanning
                      ? (language === 'en' ? 'Recognizing... (Takes a few seconds)' : '인식 중… (수 초 걸려요)')
                      : (language === 'en'
                        ? 'Tap to pick a photo or PDF — items, prices & quantities become an inbound draft'
                        : '눌러서 사진이나 PDF를 고르면, 상품·단가·수량을 읽어 입고 초안을 만들어요')}
                  </Text>
                </View>
                {scanning
                  ? <ActivityIndicator color={colors.pointOrange} />
                  : <Ionicons name="chevron-forward" size={18} color={colors.mochaBrown} />}
              </PressableScale>
            </Card>
          </View>

      {/* OCR 인식 초안 확인 */}
      {drafts.length > 0 && (
        <Card tone="cream">
          <View style={styles.rowBetween}>
            <SectionTitle>입고 초안 확인 ({drafts.length})</SectionTitle>
            <Badge label="확정 전" tone="orange" />
          </View>
          <Text style={styles.hint}>인식 결과를 확인하고 반영하세요 — 반영하면 아래 재고 현황에 바로 더해집니다</Text>
          <View style={{ gap: 12, marginTop: 12 }}>
            {drafts.map((doc) => (
              <View key={doc.id} style={styles.docBox}>
                <View style={styles.rowBetween}>
                  <Text style={styles.docVendor}>
                    {doc.result.vendor?.name ?? '거래처 미상'}
                    {doc.result.issued_date ? `  ·  ${doc.result.issued_date}` : ''}
                  </Text>
                  <Badge label={TARGET_LABEL[doc.suggested_target ?? ''] ?? '대상 미정'} tone="orange" />
                </View>

                {/* [한글 주석] 현재 편집 중인 영수증 초안인 경우 임시 편집 배열(editingItems)을 보여주고, 그 외에는 기존 읽기전용 리스트를 보여줍니다 */}
                {editingDocId === doc.id ? (
                  <View style={{ gap: 8, marginVertical: 8 }}>
                    {/* [한글 주석] 기존 품목도 값(품목명·수량·단위·단가)을 그 자리에서 바로 고칠 수 있는 입력칸 */}
                    {editingRows.map((row, idx) => (
                      <View key={idx} style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.mutedSand }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <View style={{ flex: 1 }}>
                            <TextInput
                              style={[styles.input, { height: 36, fontSize: 13 }]}
                              placeholder="품목명"
                              value={row.name}
                              onChangeText={(t) => updateRow(idx, { name: t })}
                            />
                          </View>
                          {/* [한글 주석] 품목 삭제 버튼 */}
                          <PressableScale onPress={() => handleDeleteItem(idx)} to={0.9}>
                            <Ionicons name="trash-outline" size={18} color={colors.pointOrange} />
                          </PressableScale>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <View style={{ flex: 1 }}>
                            <TextInput
                              style={[styles.input, { height: 36, fontSize: 13 }]}
                              placeholder="수량"
                              value={row.qty}
                              onChangeText={(t) => updateRow(idx, { qty: t })}
                              keyboardType="numeric"
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <TextInput
                              style={[styles.input, { height: 36, fontSize: 13 }]}
                              placeholder="단위"
                              value={row.unit}
                              onChangeText={(t) => updateRow(idx, { unit: t })}
                            />
                          </View>
                          <View style={{ flex: 1.2 }}>
                            <TextInput
                              style={[styles.input, { height: 36, fontSize: 13 }]}
                              placeholder="단가 (원)"
                              value={row.price}
                              onChangeText={(t) => updateRow(idx, { price: t })}
                              keyboardType="numeric"
                            />
                          </View>
                        </View>
                      </View>
                    ))}

                    {/* [한글 주석] 품목 직접 추가를 위한 입력 폼 UI */}
                    <View style={{ backgroundColor: colors.coffeeCream, padding: 12, borderRadius: 8, marginTop: 8, gap: 8 }}>
                      <Text style={[styles.draftName, { fontSize: 13, color: colors.mochaBrown }]}>➕ 품목 직접 추가</Text>
                      <View style={styles.formRow}>
                        <View style={{ flex: 2 }}>
                          <TextInput 
                            style={[styles.input, { height: 36, fontSize: 13 }]} 
                            placeholder="재료명 (예: 우유)" 
                            value={newItemName} 
                            onChangeText={setNewItemName} 
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <TextInput 
                            style={[styles.input, { height: 36, fontSize: 13 }]} 
                            placeholder="단위 (개/kg)" 
                            value={newItemUnit} 
                            onChangeText={setNewItemUnit} 
                          />
                        </View>
                      </View>
                      <View style={styles.formRow}>
                        <View style={{ flex: 1 }}>
                          <TextInput 
                            style={[styles.input, { height: 36, fontSize: 13 }]} 
                            placeholder="수량" 
                            value={newItemQty} 
                            onChangeText={setNewItemQty} 
                            keyboardType="numeric" 
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <TextInput 
                            style={[styles.input, { height: 36, fontSize: 13 }]} 
                            placeholder="단가 (원)" 
                            value={newItemPrice} 
                            onChangeText={setNewItemPrice} 
                            keyboardType="numeric" 
                          />
                        </View>
                      </View>
                      {/* [한글 주석] 버튼 내부 글씨가 버튼 상하 폭에 비해 비대해 보이는 현상을 막기 위해 폰트 크기를 13px로 조절 */}
                      <Button label="목록에 품목 추가" onPress={handleAddItem} style={{ height: 36, marginTop: 4 }} textStyle={{ fontSize: 13, fontWeight: '700' }} />
                    </View>
                  </View>
                ) : (
                  doc.result.items.map((item, idx) => (
                    <View key={idx} style={styles.draftRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.draftName}>{item.name}</Text>
                        <Text style={styles.draftMeta}>
                          {item.quantity != null ? `${item.quantity}${item.unit ?? '개'}` : '수량 미인식'}
                          {item.unit_price != null ? ` · 단가 ₩${item.unit_price.toLocaleString()}` : ''}
                          {item.amount != null ? ` · ₩${item.amount.toLocaleString()}` : ''}
                        </Text>
                        {item.warnings.length > 0 && <Text style={styles.warnText}>⚠ {item.warnings[0]}</Text>}
                      </View>
                    </View>
                  ))
                )}

                <View style={styles.totalRow}>
                  <Text style={styles.draftMeta}>
                    {doc.result.discount != null ? `할인 −₩${doc.result.discount.toLocaleString()}   ` : ''}
                    합계 {doc.result.total != null ? `₩${doc.result.total.toLocaleString()}` : '미인식'}
                  </Text>
                </View>
                {doc.warnings.map((w, idx) => (
                  <Text key={idx} style={styles.warnText}>⚠ {w}</Text>
                ))}

                {/* [한글 주석] 현재 편집 모드인지 여부에 따라 하단 제어 버튼들을 다르게 구성합니다 */}
                {editingDocId === doc.id ? (
                  <View style={styles.actionRow}>
                    <PressableScale 
                      style={[styles.rejectBtn, { borderColor: colors.mutedSand }]} 
                      onPress={cancelEditing} 
                      disabled={isSavingDraft}
                      to={0.9}
                    >
                      <Ionicons name="close-circle-outline" size={16} color={colors.mochaBrown} />
                      <Text style={styles.rejectText}>취소</Text>
                    </PressableScale>
                    <PressableScale 
                      style={[styles.confirmBtn, { backgroundColor: colors.pointOrange }]} 
                      onPress={() => saveEditing(doc.id)} 
                      disabled={isSavingDraft}
                      to={0.9}
                    >
                      <Ionicons name="save-outline" size={16} color={colors.white} />
                      <Text style={styles.confirmText}>{isSavingDraft ? '저장 중…' : '저장 완료'}</Text>
                    </PressableScale>
                  </View>
                ) : (
                  <View style={{ gap: 8, marginTop: 12 }}>
                    {/* [한글 주석] 반려 / 확인 버튼 상단에 수정 진입용 버튼을 추가 배치합니다 */}
                    <PressableScale 
                      style={[styles.rejectBtn, { width: '100%', justifyContent: 'center', backgroundColor: colors.white }]} 
                      onPress={() => startEditing(doc)} 
                      to={0.92}
                    >
                      <Ionicons name="create-outline" size={16} color={colors.pointOrange} />
                      <Text style={[styles.rejectText, { color: colors.pointOrange }]}>인식 결과 직접 수정 / 품목 추가</Text>
                    </PressableScale>
                    
                    <View style={styles.actionRow}>
                      <PressableScale style={styles.rejectBtn} onPress={() => reject(doc)} disabled={actingDocId != null} to={0.9}>
                        <Ionicons name="close" size={16} color={colors.mochaBrown} />
                        <Text style={styles.rejectText}>{actingDocId === doc.id ? '처리 중…' : '반려'}</Text>
                      </PressableScale>
                      <PressableScale style={styles.confirmBtn} onPress={() => confirm(doc)} disabled={actingDocId != null} to={0.9}>
                        <Ionicons name="checkmark" size={16} color={colors.white} />
                        <Text style={styles.confirmText}>{actingDocId === doc.id ? '처리 중…' : `확인했어요 · ${CONFIRM_LABEL[confirmTargetOf(doc)]}`}</Text>
                      </PressableScale>
                    </View>
                  </View>
                )}
              </View>
            ))}
          </View>
        </Card>
      )}

      {/* 재고 현황 (실데이터) */}
      <View style={{ gap: 12 }}>
        <View style={styles.rowBetween}>
          <SectionTitle>
            {language === 'en'
              ? `Stock Status (${selectedCategory === 'all' ? stocks.length : `${filteredStocks.length}/${stocks.length}`})`
              : `재고 현황 (${selectedCategory === 'all' ? stocks.length : `${filteredStocks.length}/${stocks.length}`})`}
          </SectionTitle>
          <PressableScale style={styles.addBtn} onPress={() => setFormOpen((v) => !v)} to={0.92}>
            <Ionicons name={formOpen ? 'remove' : 'add'} size={16} color={colors.white} />
            <Text style={styles.confirmText}>{formOpen ? (language === 'en' ? 'Close' : '닫기') : (language === 'en' ? 'Add Ingredient Directly' : '재료 직접 등록')}</Text>
          </PressableScale>
        </View>

        {/* [한글 주석: 가로 스크롤 대신 한눈에 들어오는 세련된 아코디언 드롭다운 카테고리 셀렉터] */}
        <View style={styles.dropdownContainer}>
          <PressableScale
            style={styles.dropdownTrigger}
            onPress={() => {
              springTransition();
              setIsCategoryOpen(!isCategoryOpen);
            }}
            to={0.97}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="filter-outline" size={15} color={colors.mochaBrown} />
              <Text style={styles.dropdownTriggerText}>
                {language === 'en' ? 'Category: ' : '카테고리: '}{selectedCategory === 'all' ? (language === 'en' ? 'All' : '전체') : (CATEGORIES.find((c) => c.id === selectedCategory)?.label || '전체')}
              </Text>
            </View>
            <Ionicons 
              name={isCategoryOpen ? 'chevron-up' : 'chevron-down'} 
              size={16} 
              color={colors.mochaBrown} 
            />
          </PressableScale>

          {/* 드롭다운 리스트 (isCategoryOpen이 true일 때 부드럽게 하단으로 노출) */}
          {isCategoryOpen && (
            <View style={styles.dropdownList}>
              {CATEGORIES.map((cat) => {
                const active = selectedCategory === cat.id;
                return (
                  <PressableScale
                    key={cat.id}
                    style={[styles.dropdownItem, active && styles.dropdownItemActive]}
                    onPress={() => {
                      springTransition();
                      setSelectedCategory(cat.id);
                      setIsCategoryOpen(false);
                    }}
                    to={0.98}
                  >
                    <Text style={[styles.dropdownItemText, active && styles.dropdownItemTextActive]}>
                      {cat.label}
                    </Text>
                    {active && (
                      <Ionicons name="checkmark" size={16} color={colors.pointOrange} />
                    )}
                  </PressableScale>
                );
              })}
            </View>
          )}
        </View>

        {/* 직접 등록 폼 */}
        {formOpen && (
          <Card tone="cream">
            <SectionTitle>재료 직접 등록</SectionTitle>
            {/* 인풋 박스가 화면 밖으로 넘치지 않도록 감싸는 View + flex 적용 */}
            <View style={styles.formRow}>
              <View style={{ flex: 2 }}>
                <TextInput style={[styles.input, { width: '100%' }]} placeholder="재료명 (예: 서울우유 1L)" value={fName} onChangeText={setFName} />
              </View>
              <View style={{ flex: 1 }}>
                <TextInput style={[styles.input, { width: '100%' }]} placeholder="단위 (팩, kg)" value={fUnit} onChangeText={setFUnit} />
              </View>
            </View>
            <View style={styles.formRow}>
              <View style={{ flex: 1 }}>
                <TextInput style={[styles.input, { width: '100%' }]} placeholder="단가 (원)" value={fPrice} onChangeText={setFPrice} keyboardType="numeric" />
              </View>
              <View style={{ flex: 1 }}>
                <TextInput style={[styles.input, { width: '100%' }]} placeholder="초기 수량" value={fQty} onChangeText={setFQty} keyboardType="numeric" />
              </View>
            </View>
            <Button label={saving ? '등록 중…' : '등록'} onPress={registerIngredient} disabled={saving} style={{ marginTop: 12 }} />
          </Card>
        )}

        {!token ? (
          <Card>
            <Text style={styles.hint}>{language === 'en' ? 'Log in to view your store stock status.' : '로그인하면 내 매장의 재고 현황이 표시됩니다.'}</Text>
          </Card>
        ) : filteredStocks.length === 0 ? (
          <Card>
            <Text style={styles.hint}>
              {selectedCategory === 'all'
                ? (language === 'en'
                    ? 'No stock registered yet. Take a receipt photo or tap "Add Ingredient Directly" to start.'
                    : '아직 등록된 재고가 없어요. 영수증을 촬영해 입고하거나 "재료 직접 등록"으로 시작해 보세요.')
                : (language === 'en' ? 'No stock found in this category.' : '해당 카테고리에 속하는 재고가 없어요.')}
            </Text>
          </Card>
        ) : (
          filteredStocks.map((s) => {
            const low = s.safety_quantity > 0 && s.current_quantity < s.safety_quantity;
            const denominator = Math.max(s.current_quantity, s.safety_quantity * 2, 1);
            return (
              <Card
                key={s.ingredient_id}
                style={focusId === s.ingredient_id ? styles.focusedCard : undefined}
                // 알림에서 넘어왔을 때 스크롤할 좌표를 기억해 둔다
                onLayout={(e) => { cardY.current[s.ingredient_id] = e.nativeEvent.layout.y; }}
              >
                <View style={styles.rowBetween}>
                  <Text style={styles.stockName}>{s.name}</Text>
                  <View style={styles.headRight}>
                    {low ? <Badge label="재고 부족" tone="danger" /> : <Badge label="정상" tone="green" />}
                    <PressableScale style={styles.delBtn} onPress={() => removeStock(s)} to={0.88}>
                      <Ionicons name="trash-outline" size={16} color="#B23B2E" />
                    </PressableScale>
                  </View>
                </View>
                <View style={styles.stockValueRow}>
                  <Text style={styles.stockValue}>
                    {s.current_quantity}
                    <Text style={styles.stockUnit}> {s.unit}</Text>
                  </Text>
                  <Text style={styles.safetyText}>
                    {s.current_price > 0 ? `단가 ₩${s.current_price.toLocaleString()} · ` : ''}
                    최소 {s.safety_quantity}{s.unit} 필요
                  </Text>
                </View>
                <ProgressBar ratio={s.current_quantity / denominator} tone={low ? 'danger' : 'mocha'} />

                {/* 재고 직접 조정 */}
                {adjustId === s.ingredient_id ? (
                  <View style={styles.adjustRow}>
                    <TextInput
                      style={styles.adjustInput}
                      placeholder={`수량 (${s.unit})`}
                      placeholderTextColor={colors.mochaBrown}
                      value={adjustQty}
                      onChangeText={setAdjustQty}
                      keyboardType="numeric"
                      autoFocus
                    />
                    <PressableScale style={styles.inBtn} onPress={() => applyAdjust(s, 1)} to={0.92}>
                      <Text style={styles.inText}>입고 +</Text>
                    </PressableScale>
                    <PressableScale style={styles.outBtn} onPress={() => applyAdjust(s, -1)} to={0.92}>
                      <Text style={styles.outText}>차감 −</Text>
                    </PressableScale>
                    <PressableScale style={styles.cancelBtn} onPress={() => { setAdjustId(null); setAdjustQty(''); }} to={0.92}>
                      <Ionicons name="close" size={16} color={colors.mochaBrown} />
                    </PressableScale>
                  </View>
                ) : (
                  <PressableScale
                    style={styles.adjustOpen}
                    onPress={() => { setAdjustId(s.ingredient_id); setAdjustQty(''); }}
                    to={0.96}
                  >
                    <Ionicons name="swap-vertical" size={15} color={colors.pointOrange} />
                    <Text style={styles.adjustOpenText}>재고 직접 입력 (입고/차감)</Text>
                  </PressableScale>
                )}
              </Card>
            );
          })
        )}
      </View>

      {/* 명세서 소스 선택 시트 — 촬영 / 앨범 / 파일(PDF) */}
      <SwipeDownModal visible={sourceSheetOpen} onClose={() => setSourceSheetOpen(false)}>
        <Text style={styles.sheetTitle}>
          {language === 'en' ? 'Add a statement' : '명세서 불러오기'}
        </Text>
        <Text style={styles.sheetSub}>
          {language === 'en'
            ? 'Pick where the statement comes from'
            : '명세서를 어디서 가져올지 골라 주세요'}
        </Text>

        <View style={styles.sheetList}>
          {/* 네이티브는 OS 카메라 앱, 웹은 앱 안 카메라 화면(CameraCaptureModal) */}
          <OcrSourceRow
            icon="camera-outline"
            label={language === 'en' ? 'Camera' : '촬영'}
            hint={language === 'en' ? 'Shoot the statement now' : '지금 카메라로 찍기'}
            onPress={() => chooseSource('camera')}
          />
          <OcrSourceRow
            icon="images-outline"
            label={language === 'en' ? 'Photo library' : '앨범'}
            hint={language === 'en' ? 'Pick a saved photo' : '저장된 사진에서 고르기'}
            onPress={() => chooseSource('album')}
          />
          <OcrSourceRow
            icon="document-attach-outline"
            label={language === 'en' ? 'File · PDF' : '파일 · PDF'}
            hint={language === 'en' ? 'PDF received by email' : '이메일로 받은 PDF 명세서'}
            onPress={() => chooseSource('file')}
          />
        </View>

        <PressableScale style={styles.sheetCancel} onPress={() => setSourceSheetOpen(false)} to={0.97}>
          <Text style={styles.sheetCancelText}>{language === 'en' ? 'Close' : '닫기'}</Text>
        </PressableScale>
      </SwipeDownModal>

      {/* 웹 전용 인앱 카메라 — 네이티브에서는 아무것도 렌더하지 않는다 */}
      <CameraCaptureModal
        visible={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(photo) => {
          setCameraOpen(false);
          uploadAsset({ uri: photo.uri, mimeType: photo.mimeType, fileName: photo.fileName });
        }}
      />
        </View>
      </Animated.ScrollView>
    </View>
  );
}

// 소스 선택 시트의 한 줄 (촬영 / 앨범 / 파일)
function OcrSourceRow({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  onPress: () => void;
}) {
  return (
    <PressableScale style={styles.ocrSourceRowBtn} onPress={onPress} to={0.97}>
      <View style={styles.ocrSourceRowIcon}>
        <Ionicons name={icon} size={20} color={colors.pointOrange} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.ocrSourceLabel}>{label}</Text>
        {hint ? <Text style={styles.ocrSourceHint}>{hint}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.mochaBrown} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  // 알림에서 넘어온 재료 — 스크롤만 하면 어느 카드였는지 모르니 잠깐 테두리를 준다.
  // colors.pointOrange는 이름과 달리 지금 값이 #2E2521(거의 검정)이라 강조가 안 된다.
  // 디자인 스펙의 테라코타를 여기서만 직접 쓴다 (초록=정상, 빨강=위험과도 겹치지 않는다).
  focusedCard: {
    borderWidth: 2,
    borderColor: '#C07030',
    shadowColor: '#C07030',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
  },
  // [관리 탭과 동일] 딥브라운 오로라 루트 + 고정 브라운 헤더 + 둥근 크림 시트
  brownRoot: { flex: 1, backgroundColor: '#1E1612' },
  // [세 탭 헤더 통일] 좌측 세로열 + 우측 마스코트, 마스코트 높이가 헤더 높이를 정한다
  brownHeader: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'space-between',
    paddingBottom: 12,
    paddingHorizontal: 18,
    gap: 10,
  },
  brownHeaderLeft: { flex: 1, justifyContent: 'center' },
  brownHeaderText: { flex: 1, paddingRight: 8 },
  // 관리 탭 헤더와 같은 높이 — 관리는 우측에 (설정 칩 + 마스코트)가 세로로 쌓여 ~126px다.
  // 재고엔 설정 칩이 없으므로 같은 높이를 확보하고 마스코트를 하단 정렬해 브라운 밴드 높이를 맞춘다.
  // 관리 탭 헤더 높이(설정칩+마스코트 ~153)에 맞춰 마스코트를 하단 정렬 — 재고엔 설정칩이 없어 minHeight로 확보
  brownHeaderRight: { alignItems: 'flex-end', justifyContent: 'flex-end', minHeight: 154 },
  brownHeaderTitle: { fontSize: 24, fontWeight: '900', color: colors.creamSand, letterSpacing: -0.5 },
  brownHeaderSub: { fontSize: 11.5, color: '#D4C9C1', marginTop: 4, fontWeight: '500', letterSpacing: -0.2 },
  brownSheet: {
    flexGrow: 1,
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 24,
    gap: 18, // 메뉴관리 · 명세서 입고 · 재고현황 세 섹션 사이 간격
  },
  brownSheetContent: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 24 },
  ocrHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  ocrHeadIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ocrSourceRowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  ocrSourceRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ocrSourceLabel: { ...typography.L3, fontSize: 14, color: colors.espressoBrown, fontWeight: '800' },
  ocrSourceHint: { ...typography.L5, color: colors.mochaBrown, fontWeight: '600', marginTop: 2 },
  sheetTitle: { ...typography.L3, fontSize: 17, color: colors.espressoBrown, fontWeight: '800' },
  sheetSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  sheetList: { gap: 10, marginTop: 16 },
  sheetCancel: { alignItems: 'center', paddingVertical: 14, marginTop: 6 },
  sheetCancelText: { ...typography.L3, fontSize: 14, color: colors.mochaBrown, fontWeight: '700' },
  hint: { ...typography.L5, color: colors.mochaBrown, marginTop: 4 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  menuNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.coffeeCream,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 14,
    marginTop: 4,
    marginBottom: 0,
  },
  menuNavIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuNavTitle: { ...typography.L3, color: colors.espressoBrown },
  menuNavSub: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  delBtn: { padding: 6, borderRadius: 9, backgroundColor: 'rgba(178,59,46,0.08)' },
  adjustOpen: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 12, alignSelf: 'flex-start' },
  adjustOpenText: { ...typography.L5, color: colors.pointOrange, fontWeight: '700' },
  adjustRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  adjustInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.white,
    ...typography.L5,
    color: colors.espressoBrown,
  },
  inBtn: { backgroundColor: colors.trendGreenText, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  inText: { ...typography.L5, color: colors.white, fontWeight: '700' },
  outBtn: { backgroundColor: '#B23B2E', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  outText: { ...typography.L5, color: colors.white, fontWeight: '700' },
  cancelBtn: { padding: 8 },
  docBox: {
    backgroundColor: colors.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    padding: 12,
    gap: 8,
  },
  docVendor: { ...typography.L4, color: colors.espressoBrown, fontWeight: '700' },
  draftRow: { flexDirection: 'row', alignItems: 'center' },
  draftName: { ...typography.L4, color: colors.espressoBrown },
  draftMeta: { ...typography.L5, color: colors.mochaBrown, marginTop: 3 },
  warnText: { ...typography.L5, color: colors.pointOrange, marginTop: 3 },
  totalRow: { borderTopWidth: 1, borderTopColor: colors.mutedSand, paddingTop: 8, alignItems: 'flex-end' },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.trendGreenText,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.pointOrange,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  confirmText: { ...typography.L5, color: colors.white, fontWeight: '700' },
  rejectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  rejectText: { ...typography.L5, color: colors.mochaBrown, fontWeight: '700' },
  formRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  input: {
    minWidth: 0, // 웹 flex 자식이 콘텐츠보다 작게 줄어들 수 있게 (넘침 방지)
    borderWidth: 1,
    borderColor: colors.mutedSand,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: colors.white,
    ...typography.L5,
    color: colors.espressoBrown,
  },
  stockName: { ...typography.L3, color: colors.espressoBrown },
  stockValueRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 10, marginBottom: 8 },
  stockValue: { ...typography.L2, color: colors.espressoBrown },
  stockUnit: { ...typography.L4, color: colors.mochaBrown },
  safetyText: { ...typography.L5, color: colors.mochaBrown },

  // [한글 주석] 재고 카테고리 필터 칩 바 스타일
  categoryBar: {
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 4,
    marginBottom: 4,
  },
  categoryChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(242, 236, 224, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(140, 111, 86, 0.15)',
  },
  categoryChipActive: {
    backgroundColor: colors.espressoBrown,
    borderColor: colors.espressoBrown,
  },
  categoryChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.mochaBrown,
  },
  categoryChipTextActive: {
    color: colors.white,
    fontWeight: '800',
  },

  // [한글 주석: 세련된 카테고리 드롭다운 스타일 리스트]
  dropdownContainer: {
    position: 'relative',
    zIndex: 50,
    width: '100%',
    marginBottom: 4,
  },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.white,
    borderWidth: 1.2,
    borderColor: 'rgba(140, 111, 86, 0.18)',
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  dropdownTriggerText: {
    ...typography.L4,
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.espressoBrown,
  },
  dropdownList: {
    marginTop: 6,
    borderRadius: 12,
    backgroundColor: colors.white,
    borderWidth: 1.2,
    borderColor: 'rgba(140, 111, 86, 0.18)',
    padding: 6,
    shadowColor: '#4E3629',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    gap: 2,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  dropdownItemActive: {
    backgroundColor: 'rgba(140, 111, 86, 0.06)',
  },
  dropdownItemText: {
    ...typography.L4,
    fontSize: 13,
    color: colors.mochaBrown,
    fontWeight: '600',
  },
  dropdownItemTextActive: {
    color: colors.espressoBrown,
    fontWeight: '800',
  },
});
