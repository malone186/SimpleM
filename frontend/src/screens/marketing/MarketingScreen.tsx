// 홍보 스튜디오 (백엔드 B) — AI 홍보 문구 + 고품질 홍보 이미지 자동 생성
//
// 흐름: 채널·주제 입력 → [홍보물 만들기] → ① 문구 생성(매장 실데이터 근거) →
//       ② 그 문구에 맞는 이미지 자동 생성 → 결과 카드(이미지·캡션·해시태그·팁) → 복사·공유.
//
// 이미지는 서버가 프롬프트 정교화 → 생성(Gemini 유료 키 → Pollinations 무료) → 마감 보정 →
// 한글 슬로건 합성까지 처리한다. 슬로건 위치는 AI 재호출 없이 즉시 바꿀 수 있고(원본을
// 서버가 들고 있다), 마음에 안 들면 이미지만 다시 그릴 수 있다.
//
// 지난 홍보물은 보관함(문서 kind=marketing_content)에서 다시 열어볼 수 있다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRoute } from '@react-navigation/native';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { Button, Card, Divider, Screen, SectionTitle } from '../../components/ui';
import { SwipeDownModal } from '../../components/ui/SwipeDownModal';
import { describeApiFailure } from '../../lib/api/errors';
import {
  CHANNEL_META,
  OVERLAY_META,
  PHOTO_BG_STYLES,
  aspectToNumber,
  createPhotoPromoImage,
  createPromotionCopy,
  createPromotionImage,
  deletePromotion,
  listPromotions,
  promoFilename,
  promoImageUrl,
  promotionBody,
  promotionText,
  restylePromotionImage,
  type OverlayLayout,
  type PromotionChannel,
  type PromotionDoc,
  type PromotionImage,
} from '../../lib/api/marketing';
import {
  canCopyImage,
  canDownload,
  copyImage,
  copyText,
  openSms,
  openUrl,
  saveImage,
  shareImage,
  shareText,
} from '../../lib/share/promoShare';
import { colors } from '../../theme';

const CHANNELS = Object.keys(CHANNEL_META) as PromotionChannel[];

// 이미지 느낌 프리셋 — 서버에 영어 아트 디렉션으로 전달돼 결과 느낌이 완전히 달라진다.
// '자동'은 문구 AI가 주제·톤에 맞는 스타일을 스스로 고른다.
// 주의: 'poster'·'sign' 같은 단어는 모델이 가짜 글자(깨진 활자)를 그려 넣게 유발한다
// (실측) — 글자를 부르지 않는 표현으로 같은 느낌을 묘사한다.
const IMAGE_STYLES: { key: string; label: string }[] = [
  { key: '', label: '자동' },
  { key: 'photorealistic professional photography', label: '실사 사진' },
  { key: 'soft watercolor illustration, gentle pastel tones', label: '수채화' },
  { key: 'bold flat vector illustration, vivid color blocks, strong geometric shapes', label: '그래픽 아트' },
  { key: 'retro film photography, warm grain, nostalgic 90s mood', label: '레트로 필름' },
  { key: 'cozy hand-drawn illustration, storybook style', label: '손그림 동화' },
  { key: 'vivid neon color palette, glowing light effects, energetic pop mood', label: '네온 팝' },
];

/** 생성 진행 단계 — 문구와 이미지가 순차로 만들어지는 걸 사장님이 볼 수 있게 */
type Phase = 'idle' | 'copy' | 'image' | 'restyle';

export default function MarketingScreen() {
  const { token } = useAuth();
  const route = useRoute<any>();

  // 입력 폼
  const [channel, setChannel] = useState<PromotionChannel>('instagram');
  const [topic, setTopic] = useState('');
  const [tone, setTone] = useState('');
  const [menu, setMenu] = useState('');
  const [imageStyle, setImageStyle] = useState(''); // IMAGE_STYLES의 key (빈 값 = 자동)
  const [photoBgStyle, setPhotoBgStyle] = useState('wood'); // 실물 사진 합성 배경

  // [브루 추천 연결] 투두의 '홍보하러 가기'로 들어오면 홍보할 메뉴·주제가 자동 입력된다.
  // ts를 의존성에 둬서 같은 메뉴를 다시 눌러도(파라미터 갱신) 다시 채워진다.
  const autoRanTs = useRef<number>(0);
  useEffect(() => {
    const prefill = (route.params?.prefillMenu ?? '').trim();
    if (!prefill) return;
    setMenu(prefill);
    const autoTopic = `${prefill} 집중 홍보`;
    setTopic(autoTopic);
    // 메뉴를 고른 순간 문구+이미지까지 자동 생성 — 결과가 뜨면 그 위에서 수정하면 된다.
    // ts(누른 시각)로 같은 진입의 중복 실행을 막고, 재진입(새 ts)이면 다시 생성한다.
    const ts = route.params?.ts ?? 0;
    if (autoRanTs.current === ts) return;
    autoRanTs.current = ts;
    generate({ topic: autoTopic, menu: prefill });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.prefillMenu, route.params?.ts]);

  // 생성 상태·결과
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<PromotionDoc | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string>(''); // 여러 장 중 보고 있는 것
  const [showRaw, setShowRaw] = useState(false); // 글자 없는 원본 보기
  const [shareOpen, setShareOpen] = useState(false);

  // 보관함
  const [history, setHistory] = useState<PromotionDoc[]>([]);

  const refreshHistory = useCallback(async () => {
    if (!token) return;
    try {
      setHistory(await listPromotions(token));
    } catch {
      // 목록 실패는 치명적이지 않다 — 생성 기능은 그대로 동작
    }
  }, [token]);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const c = result?.content;
  const images = useMemo<PromotionImage[]>(() => c?.images ?? [], [c]);
  const image = useMemo(
    () => images.find((i) => i.image_id === selectedImageId) ?? images[images.length - 1] ?? null,
    [images, selectedImageId]
  );
  const hashtagLine = (c?.hashtags ?? []).join(' ');
  const body = c ? promotionBody(c) : '';
  const fullText = c ? promotionText(c) : '';
  // 화면에 실제로 보여주는(= 저장·공유될) 이미지
  const shownUrl = image ? promoImageUrl(showRaw ? image.raw_url || image.url : image.url) : '';
  const busy = phase !== 'idle';

  /** 문서를 갱신하면서 보고 있던 이미지 선택을 유지한다 */
  const applyDoc = (doc: PromotionDoc, focusImageId?: string) => {
    setResult(doc);
    const imgs = doc.content.images ?? [];
    setSelectedImageId(focusImageId ?? imgs[imgs.length - 1]?.image_id ?? '');
  };

  /** 문구 → 이미지 순서로 자동 생성. 문구가 나오는 즉시 화면에 먼저 보여준다.
   * overrides: 투두의 '홍보할 메뉴 고르기'로 진입한 직후엔 setState가 아직 반영 전이라
   * 명시적 값으로 바로 생성한다 (버튼 클릭 시엔 인자 없이 상태값 사용). */
  const generate = async (overrides?: { topic?: string; menu?: string }) => {
    if (!token) {
      toast('로그인이 필요해요', '로그인 후 홍보물을 만들 수 있습니다.');
      return;
    }
    if (busy) return;

    setPhase('copy');
    setResult(null);
    setSelectedImageId('');
    setShowRaw(false);
    try {
      const doc = await createPromotionCopy(token, {
        topic: overrides?.topic ?? topic, channel, tone, menu: overrides?.menu ?? menu,
      });
      setResult(doc); // 문구 먼저 표시 — 이미지는 아래에서 이어서

      setPhase('image');
      const img = await createPromotionImage(token, {
        doc_id: doc.id,
        style: imageStyle,
        aspect_ratio: CHANNEL_META[channel].aspect,
      });
      if (img.doc) applyDoc(img.doc, img.image_id);
      refreshHistory();
    } catch (e) {
      toast('홍보물 생성 실패', describeApiFailure(e, '홍보물').message);
    } finally {
      setPhase('idle');
    }
  };

  /** 실물 메뉴 사진으로 만들기 — 사진 선택 → (문구 없으면 먼저 생성) → 누끼+배경 합성.
   * AI 생성 이미지와 달리 '진짜 우리 메뉴'가 그대로 담긴다. */
  const makeFromPhoto = async () => {
    if (!token) {
      toast('로그인이 필요해요', '로그인 후 홍보물을 만들 수 있습니다.');
      return;
    }
    if (busy) return;
    let ImagePicker: any;
    try {
      ImagePicker = require('expo-image-picker');
    } catch {
      toast('사진 선택을 쓸 수 없어요', '이 버전 앱에는 사진 선택 모듈이 없어요.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.92,
    });
    if (picked.canceled || !picked.assets?.length) return;
    const a = picked.assets[0];

    try {
      let doc = result;
      if (!doc) {
        // 문구가 아직 없으면 먼저 만들어 사진 이미지가 문서에 함께 묶이게 한다.
        // 단, 문구는 Gemini 쿼터에 묶여 실패할 수 있다 — 그래도 사진 합성(쿼터 무관)은
        // 계속 진행한다. 문구 없이 이미지만이라도 손에 쥐여주는 게 이 기능의 본질이다.
        setPhase('copy');
        try {
          doc = await createPromotionCopy(token, { topic, channel, tone, menu });
          setResult(doc);
        } catch (copyErr) {
          toast('문구는 잠시 쉬어요', describeApiFailure(copyErr, '홍보 문구').message);
          doc = null;
        }
      }
      setPhase('image');
      const img = await createPhotoPromoImage(
        token,
        { uri: a.uri, mimeType: a.mimeType, fileName: a.fileName },
        { doc_id: doc?.id ?? '', style: photoBgStyle, aspect_ratio: CHANNEL_META[channel].aspect },
      );
      if (img.doc) {
        applyDoc(img.doc, img.image_id);
      } else {
        // 문구 없이 만든 독립 이미지 — 화면에 보이도록 최소 문서 형태로 감싼다
        applyDoc({
          id: '',
          kind: 'marketing_content',
          title: '실물 사진 홍보 이미지',
          content: {
            channel, channel_label: '', topic, tone, focus_menu: menu, store_name: '',
            headline: '', sub_headline: '', body: '', sns_caption: '', hashtags: [],
            short_slogan: '', image_prompt: '', posting_tip: '', images: [img],
          },
        } as any, img.image_id);
      }
      refreshHistory();
      toast('내 사진으로 만들었어요', '실물 메뉴에 감성 배경을 입혔어요!');
    } catch (e) {
      toast('사진 합성 실패', describeApiFailure(e, '사진 합성').message);
    } finally {
      setPhase('idle');
    }
  };

  /** 문구는 그대로 두고 이미지만 새로 한 장 더 — 여러 장 중 마음에 드는 걸 고른다 */
  const regenerateImage = async () => {
    if (!token || !result || busy) return;
    setPhase('image');
    setShowRaw(false);
    try {
      const img = await createPromotionImage(token, {
        doc_id: result.id,
        style: imageStyle,
        aspect_ratio: image?.aspect_ratio || CHANNEL_META[result.content.channel].aspect,
      });
      if (img.doc) applyDoc(img.doc, img.image_id);
      refreshHistory();
    } catch (e) {
      toast('이미지 생성 실패', describeApiFailure(e, '홍보 이미지').message);
    } finally {
      setPhase('idle');
    }
  };

  /** 문구만 다시 쓰기 — 같은 조건으로 새 홍보물을 만든다 (AI는 매번 다르게 쓴다) */
  const rewriteCopy = async () => {
    if (!token || !result || busy) return;
    const src = result.content;
    setPhase('copy');
    try {
      const doc = await createPromotionCopy(token, {
        topic: src.topic,
        channel: src.channel,
        tone: src.tone,
        menu: src.focus_menu,
      });
      applyDoc(doc);
      setShowRaw(false);
      refreshHistory();
      toast('✍️ 문구를 새로 썼어요', '이미지도 새 문구에 맞춰 다시 그려보세요.');
    } catch (e) {
      toast('문구 생성 실패', describeApiFailure(e, '홍보 문구').message);
    } finally {
      setPhase('idle');
    }
  };

  /** 슬로건 위치 변경 — 서버가 원본을 다시 합성한다 (AI 재호출 없음) */
  const changeOverlay = async (layout: OverlayLayout) => {
    if (!token || !result || !image || busy) return;
    setPhase('restyle');
    try {
      const res = await restylePromotionImage(token, {
        doc_id: result.id,
        image_id: image.image_id,
        layout,
      });
      if (res.doc) applyDoc(res.doc, res.image_id);
      setShowRaw(false);
    } catch (e) {
      toast('글자 위치 변경 실패', describeApiFailure(e, '홍보 이미지').message);
    } finally {
      setPhase('idle');
    }
  };

  const removeDoc = async (doc: PromotionDoc) => {
    if (!token) return;
    try {
      await deletePromotion(token, doc.id);
      if (result?.id === doc.id) setResult(null);
      refreshHistory();
      toast('🗑️ 삭제 완료', '홍보물을 삭제했어요.');
    } catch (e) {
      toast('삭제 실패', describeApiFailure(e, '홍보물').message);
    }
  };

  // --- 복사 ---------------------------------------------------------------
  const doCopyText = async (text: string, label: string) => {
    if (!text) return;
    if (await copyText(text)) {
      toast('📋 복사 완료', `${label}을(를) 클립보드에 복사했어요.`);
    } else {
      await shareText(text); // 클립보드가 막힌 환경 — 공유 시트로 대신
    }
  };

  const doCopyImage = async () => {
    if (!shownUrl) return;
    toast('🖼️ 이미지 복사 중', '잠시만요...');
    if (await copyImage(shownUrl)) {
      toast('🖼️ 이미지 복사 완료', '인스타·카톡에 바로 붙여넣을 수 있어요.');
    } else {
      toast('이미지 복사 실패', '대신 [공유하기]로 이미지를 내보낼 수 있어요.');
    }
  };

  // --- 공유 ---------------------------------------------------------------
  const filename = image ? promoFilename(image) : 'promo.jpg';

  /** 인스타그램 스토리 — 문구를 미리 복사해 두고 이미지 공유 시트를 연다 */
  const shareToInstagram = async () => {
    setShareOpen(false);
    await copyText(fullText);
    if (!shownUrl) {
      await shareText(fullText);
      return;
    }
    toast('📸 문구는 복사해뒀어요', '공유 시트에서 Instagram → 스토리를 선택하세요.');
    if (!(await shareImage(shownUrl, filename, fullText))) {
      toast('공유 실패', '이미지를 저장한 뒤 인스타그램에서 직접 올려주세요.');
    }
  };

  /** 카카오톡·밴드 등 — 이미지 공유 시트 */
  const shareToApps = async () => {
    setShareOpen(false);
    await copyText(fullText);
    if (!shownUrl) {
      await shareText(fullText);
      return;
    }
    if (!(await shareImage(shownUrl, filename, fullText))) {
      toast('공유 실패', '이미지를 저장한 뒤 직접 올려주세요.');
    }
  };

  const shareToSms = async () => {
    setShareOpen(false);
    const text = c ? `${c.headline}\n${body}` : '';
    if (Platform.OS === 'web') {
      await doCopyText(text, '문자 문구');
      return;
    }
    if (!(await openSms(text))) await doCopyText(text, '문자 문구');
  };

  const doSaveImage = async () => {
    setShareOpen(false);
    if (!shownUrl) return;
    const res = await saveImage(shownUrl, filename);
    if (res === 'downloaded') toast('💾 저장 완료', '다운로드 폴더에 이미지를 저장했어요.');
    else if (res === 'failed') toast('저장 실패', '잠시 후 다시 시도해 주세요.');
  };

  const openBlogWrite = async () => {
    setShareOpen(false);
    await copyText(fullText);
    toast('📝 문구를 복사했어요', '블로그 글쓰기 창에 붙여넣으세요.');
    await openUrl('https://blog.naver.com/GoBlogWrite.naver');
  };

  return (
    <Screen>
      {/* ① 만들기 폼 */}
      <SectionTitle>어디에 올릴 홍보물인가요?</SectionTitle>
      <View style={styles.channelRow}>
        {CHANNELS.map((ch) => {
          const active = channel === ch;
          const meta = CHANNEL_META[ch];
          return (
            <PressableScale
              key={ch}
              style={[styles.channelChip, active && styles.channelChipActive]}
              onPress={() => setChannel(ch)}
              to={0.93}
            >
              <Ionicons
                name={meta.icon as any}
                size={14}
                color={active ? colors.white : colors.mochaBrown}
              />
              <Text style={[styles.channelText, active && styles.channelTextActive]}>
                {meta.label}
              </Text>
            </PressableScale>
          );
        })}
      </View>

      <Card style={{ marginTop: 12 }}>
        <Text style={styles.fieldLabel}>홍보 주제</Text>
        <TextInput
          style={styles.input}
          value={topic}
          onChangeText={setTopic}
          placeholder="예: 신메뉴 딸기라떼 출시 (비우면 매장 일반 홍보)"
          placeholderTextColor={colors.mochaBrown + '88'}
        />
        <Text style={[styles.fieldLabel, { marginTop: 10 }]}>이미지 느낌</Text>
        <View style={styles.styleRow}>
          {IMAGE_STYLES.map((s) => {
            const active = imageStyle === s.key;
            return (
              <PressableScale
                key={s.label}
                style={[styles.styleChip, active && styles.styleChipActive]}
                onPress={() => setImageStyle(s.key)}
                to={0.93}
              >
                <Text style={[styles.styleText, active && styles.styleTextActive]}>
                  {s.label}
                </Text>
              </PressableScale>
            );
          })}
        </View>

        <View style={styles.inputRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.fieldLabel}>말투 (선택)</Text>
            <TextInput
              style={styles.input}
              value={tone}
              onChangeText={setTone}
              placeholder="예: 감성적으로"
              placeholderTextColor={colors.mochaBrown + '88'}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.fieldLabel}>강조 메뉴 (선택)</Text>
            <TextInput
              style={styles.input}
              value={menu}
              onChangeText={setMenu}
              placeholder="예: 아인슈페너"
              placeholderTextColor={colors.mochaBrown + '88'}
            />
          </View>
        </View>

        <Button
          label={
            phase === 'copy'
              ? '눈길 끄는 문구를 쓰는 중...'
              : phase === 'image'
                ? '홍보 이미지를 그리는 중...'
                : '✨ AI 홍보물 만들기 (문구 + 이미지)'
          }
          onPress={() => generate()}
          disabled={busy}
          style={{ marginTop: 14 }}
        />

        {/* ── 실물 사진으로 만들기 — AI가 '전체'를 그리는 위 버튼과 달리,
              여기는 올린 사진의 메뉴는 그대로 두고 '배경만' 만들어 합성한다 ── */}
        <View style={styles.photoDividerRow}>
          <View style={styles.photoDividerLine} />
          <Text style={styles.photoDividerText}>또는</Text>
          <View style={styles.photoDividerLine} />
        </View>
        <View style={styles.photoBox}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <Ionicons name="camera" size={17} color={colors.espressoBrown} />
            <Text style={styles.photoBoxTitle}>실물 사진으로 만들기</Text>
          </View>
          <Text style={styles.photoHint}>
            메뉴 사진을 올리면 <Text style={{ fontWeight: '800' }}>메뉴는 그대로 두고 배경만</Text> 감성
            컷으로 바꿔 드려요. AI가 그린 가짜 메뉴가 아니라 진짜 우리 메뉴가 담깁니다.
          </Text>
          <View style={styles.styleRow}>
            {PHOTO_BG_STYLES.map((s2) => {
              const active = photoBgStyle === s2.key;
              return (
                <PressableScale
                  key={s2.key}
                  style={[styles.styleChip, active && styles.styleChipActive]}
                  onPress={() => setPhotoBgStyle(s2.key)}
                  to={0.93}
                >
                  <Text style={[styles.styleText, active && styles.styleTextActive]}>
                    {s2.label}
                  </Text>
                </PressableScale>
              );
            })}
          </View>
          <PressableScale
            style={[styles.photoUploadBtn, busy && { opacity: 0.55 }]}
            onPress={makeFromPhoto}
            disabled={busy}
            to={0.97}
          >
            <Ionicons name="image-outline" size={17} color={colors.white} />
            <Text style={styles.photoUploadBtnText}>
              {phase === 'image' ? '내 사진에 배경 입히는 중…' : '📷 메뉴 사진 올려서 만들기'}
            </Text>
          </PressableScale>
        </View>
        {busy && phase !== 'restyle' && (
          <View style={styles.progressRow}>
            <ActivityIndicator size="small" color={colors.pointOrange} />
            <Text style={styles.progressText}>
              {phase === 'copy'
                ? '매장 정보(베스트 메뉴·위치)를 바탕으로 작성하고 있어요'
                : '구도·조명까지 지시한 고화질 이미지를 그리고 슬로건을 얹는 중이에요 (15초 안팎)'}
            </Text>
          </View>
        )}
      </Card>

      {/* ② 결과 카드 */}
      {c && (
        <>
          <SectionTitle>완성된 홍보물</SectionTitle>
          <Card>
            {image ? (
              <View>
                <Image
                  source={{ uri: shownUrl }}
                  style={[styles.promoImage, { aspectRatio: aspectToNumber(image.aspect_ratio) }]}
                  resizeMode="cover"
                />
                {phase === 'restyle' && (
                  <View style={styles.imageBusy}>
                    <ActivityIndicator color={colors.white} />
                  </View>
                )}
                {/* 슬로건 버전 ↔ 글자 없는 원본 */}
                {!!image.raw_url && image.raw_url !== image.url && (
                  <PressableScale
                    style={styles.rawToggle}
                    onPress={() => setShowRaw((v) => !v)}
                    to={0.9}
                  >
                    <Ionicons
                      name={showRaw ? 'text-outline' : 'image-outline'}
                      size={13}
                      color={colors.white}
                    />
                    <Text style={styles.rawToggleText}>
                      {showRaw ? '슬로건 버전' : '글자 없는 원본'}
                    </Text>
                  </PressableScale>
                )}
              </View>
            ) : phase === 'image' ? (
              <View style={[styles.promoImage, styles.imagePlaceholder]}>
                <ActivityIndicator color={colors.pointOrange} />
                <Text style={styles.placeholderText}>이미지 생성 중...</Text>
              </View>
            ) : null}

            {/* 이미지 여러 장 — 썸네일로 골라 본다 */}
            {images.length > 1 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginBottom: 10 }}
                contentContainerStyle={{ gap: 8 }}
              >
                {images.map((img, i) => (
                  <PressableScale
                    key={img.image_id}
                    onPress={() => {
                      setSelectedImageId(img.image_id);
                      setShowRaw(false);
                    }}
                    to={0.92}
                  >
                    <Image
                      source={{ uri: promoImageUrl(img.url) }}
                      style={[
                        styles.variantThumb,
                        img.image_id === image?.image_id && styles.variantThumbActive,
                      ]}
                    />
                    <Text style={styles.variantIndex}>{i + 1}</Text>
                  </PressableScale>
                ))}
              </ScrollView>
            )}

            {/* 슬로건 위치 — 즉시 반영 (AI 재호출 없음) */}
            {!!image && !!c.short_slogan && (
              <View style={styles.overlayRow}>
                <Text style={styles.overlayLabel}>글자 위치</Text>
                {OVERLAY_META.map((o) => {
                  const active = (image.overlay ?? 'none') === o.key;
                  return (
                    <PressableScale
                      key={o.key}
                      style={[styles.overlayChip, active && styles.overlayChipActive]}
                      onPress={() => !active && changeOverlay(o.key)}
                      to={0.92}
                    >
                      <Text style={[styles.overlayText, active && styles.overlayTextActive]}>
                        {o.label}
                      </Text>
                    </PressableScale>
                  );
                })}
              </View>
            )}

            {!!image && (
              <View style={styles.redoRow}>
                <PressableScale style={styles.redoBtn} onPress={regenerateImage} to={0.95}>
                  <Ionicons name="refresh" size={13} color={colors.espressoBrown} />
                  <Text style={styles.redoText}>이미지 다시 그리기</Text>
                </PressableScale>
                <PressableScale style={styles.redoBtn} onPress={rewriteCopy} to={0.95}>
                  <Ionicons name="create-outline" size={13} color={colors.espressoBrown} />
                  <Text style={styles.redoText}>문구 다시 쓰기</Text>
                </PressableScale>
              </View>
            )}

            <View style={styles.headlineRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.headline}>{c.headline}</Text>
                {!!c.sub_headline && <Text style={styles.subHeadline}>{c.sub_headline}</Text>}
              </View>
              <CopyIcon onPress={() => doCopyText(c.headline, '헤드라인')} />
            </View>

            <Divider style={{ marginVertical: 12 }} />

            <View style={styles.labelRow}>
              <Text style={styles.fieldLabel}>
                {c.channel === 'sms' ? '문자 내용' : c.channel === 'instagram' ? '캡션' : '본문'}
                <Text style={styles.charCount}>  {body.length}자</Text>
              </Text>
              <CopyIcon onPress={() => doCopyText(body, '본문')} />
            </View>
            <Text style={styles.bodyText}>{body}</Text>

            {c.hashtags?.length > 0 && (
              <>
                <View style={[styles.labelRow, { marginTop: 12 }]}>
                  <Text style={styles.fieldLabel}>해시태그 {c.hashtags.length}개</Text>
                  <CopyIcon onPress={() => doCopyText(hashtagLine, '해시태그')} />
                </View>
                <View style={styles.hashtagWrap}>
                  {c.hashtags.map((h) => (
                    <View key={h} style={styles.hashtagChip}>
                      <Text style={styles.hashtagText}>{h}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}

            {!!c.posting_tip && (
              <View style={styles.tipBox}>
                <Ionicons name="bulb-outline" size={14} color={colors.espressoBrown} />
                <Text style={styles.tipText}>{c.posting_tip}</Text>
              </View>
            )}

            <View style={styles.actionRow}>
              <Button
                label="문구 전체 복사"
                variant="secondary"
                style={{ flex: 1 }}
                onPress={() => doCopyText(fullText, '문구')}
              />
              {canCopyImage && !!image && (
                <Button
                  label="이미지 복사"
                  variant="secondary"
                  style={{ flex: 1 }}
                  onPress={doCopyImage}
                />
              )}
              <Button label="공유하기" style={{ flex: 1 }} onPress={() => setShareOpen(true)} />
            </View>
            {image?.provider === 'pollinations' && !image?.overlay && (
              <Text style={styles.providerNote}>
                무료 AI 이미지 — 글자는 캡션으로 함께 올려주세요
              </Text>
            )}
          </Card>
        </>
      )}

      {/* ③ 보관함 */}
      {history.length > 0 && (
        <>
          <SectionTitle>지난 홍보물</SectionTitle>
          <Card>
            {history.map((doc, i) => {
              const thumb = doc.content.images?.[doc.content.images.length - 1];
              return (
                <View key={doc.id}>
                  {i > 0 && <Divider style={{ marginVertical: 8 }} />}
                  <PressableScale
                    style={styles.historyRow}
                    onPress={() => {
                      applyDoc(doc);
                      setShowRaw(false);
                    }}
                    to={0.97}
                  >
                    {thumb ? (
                      <Image
                        source={{ uri: promoImageUrl(thumb.url) }}
                        style={styles.historyThumb}
                      />
                    ) : (
                      <View style={[styles.historyThumb, styles.historyThumbEmpty]}>
                        <Ionicons name="text-outline" size={16} color={colors.mochaBrown} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyTitle} numberOfLines={1}>
                        {doc.content.headline || doc.title}
                      </Text>
                      <Text style={styles.historyMeta}>
                        {doc.content.channel_label || ''} ·{' '}
                        {String(doc.created_at).slice(0, 10)}
                      </Text>
                    </View>
                    <PressableScale
                      onPress={() => removeDoc(doc)}
                      style={styles.deleteBtn}
                      to={0.85}
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.mochaBrown} />
                    </PressableScale>
                  </PressableScale>
                </View>
              );
            })}
          </Card>
        </>
      )}

      {/* 공유 시트 */}
      <SwipeDownModal visible={shareOpen} onClose={() => setShareOpen(false)}>
        <Text style={styles.sheetTitle}>어디에 올릴까요?</Text>
        <Text style={styles.sheetHint}>
          어디로 보내든 문구는 자동으로 복사돼요 — 붙여넣기만 하면 됩니다.
        </Text>
        <ShareRow
          icon="logo-instagram"
          title="인스타그램 스토리·피드"
          desc="공유 시트에서 Instagram → 스토리를 선택하세요"
          onPress={shareToInstagram}
          disabled={!image}
        />
        <ShareRow
          icon="share-social-outline"
          title="다른 앱으로 보내기"
          desc="카카오톡·밴드·메일 등"
          onPress={shareToApps}
          disabled={!image}
        />
        <ShareRow
          icon="chatbox-ellipses-outline"
          title="단골에게 문자로"
          desc={Platform.OS === 'web' ? '문구를 복사합니다' : '문자 앱이 문구와 함께 열려요'}
          onPress={shareToSms}
        />
        {c?.channel === 'blog' && (
          <ShareRow
            icon="reader-outline"
            title="네이버 블로그에 쓰기"
            desc="글쓰기 창을 열고 문구를 복사해요"
            onPress={openBlogWrite}
          />
        )}
        <ShareRow
          icon={canDownload ? 'download-outline' : 'save-outline'}
          title={canDownload ? '이미지 저장' : '사진에 저장'}
          desc={canDownload ? '고화질 원본을 내려받아요' : '공유 시트의 [이미지 저장]을 선택하세요'}
          onPress={doSaveImage}
          disabled={!image}
        />
        <ShareRow
          icon="text-outline"
          title="문구만 공유"
          desc="이미지 없이 텍스트만"
          onPress={() => {
            setShareOpen(false);
            shareText(fullText);
          }}
        />
      </SwipeDownModal>
    </Screen>
  );
}

/** 작은 복사 아이콘 버튼 — 항목별로 따로 복사할 수 있게 */
function CopyIcon({ onPress }: { onPress: () => void }) {
  return (
    <PressableScale style={styles.copyIcon} onPress={onPress} to={0.85}>
      <Ionicons name="copy-outline" size={15} color={colors.mochaBrown} />
    </PressableScale>
  );
}

/** 공유 시트의 한 줄 */
function ShareRow({
  icon,
  title,
  desc,
  onPress,
  disabled,
}: {
  icon: string;
  title: string;
  desc: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <PressableScale
      style={[styles.shareRow, disabled && { opacity: 0.4 }]}
      onPress={() => !disabled && onPress()}
      to={0.97}
    >
      <View style={styles.shareIcon}>
        <Ionicons name={icon as any} size={18} color={colors.espressoBrown} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.shareTitle}>{title}</Text>
        <Text style={styles.shareDesc}>{desc}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.mochaBrown} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  channelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  channelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.25)',
  },
  channelChipActive: {
    backgroundColor: colors.espressoBrown,
    borderColor: colors.espressoBrown,
  },
  channelText: { fontSize: 12.5, fontWeight: '700', color: colors.mochaBrown },
  channelTextActive: { color: colors.white },

  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.mochaBrown,
    marginBottom: 6,
    marginTop: 4,
  },
  charCount: { fontSize: 11, fontWeight: '600', color: colors.mochaBrown + 'aa' },
  input: {
    backgroundColor: 'rgba(140,111,86,0.07)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'web' ? 10 : 9,
    fontSize: 13.5,
    color: colors.espressoBrown,
  },
  inputRow: { flexDirection: 'row', gap: 10, marginTop: 8 },

  styleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  styleChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(140,111,86,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.18)',
  },
  styleChipActive: {
    backgroundColor: colors.pointOrange,
    borderColor: colors.pointOrange,
  },
  styleText: { fontSize: 11.5, fontWeight: '700', color: colors.mochaBrown },
  styleTextActive: { color: colors.white },
  photoHint: { fontSize: 11, color: colors.mochaBrown, marginTop: 6, lineHeight: 16 },
  photoDividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, marginBottom: 10 },
  photoDividerLine: { flex: 1, height: 1, backgroundColor: colors.mutedSand },
  photoDividerText: { fontSize: 11, fontWeight: '700', color: colors.mochaBrown },
  photoBox: {
    backgroundColor: colors.coffeeCream,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  photoBoxTitle: { fontSize: 14.5, fontWeight: '900', color: colors.espressoBrown },
  photoUploadBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.espressoBrown, borderRadius: 12, paddingVertical: 13, marginTop: 10,
  },
  photoUploadBtnText: { color: colors.white, fontSize: 13.5, fontWeight: '800' },

  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    justifyContent: 'center',
  },
  progressText: { fontSize: 12, color: colors.mochaBrown, flexShrink: 1 },

  promoImage: {
    width: '100%',
    borderRadius: 14,
    marginBottom: 12,
    backgroundColor: 'rgba(140,111,86,0.08)',
  },
  imageBusy: {
    ...StyleSheet.absoluteFillObject,
    bottom: 12,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  rawToggle: {
    position: 'absolute',
    right: 10,
    top: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  rawToggleText: { fontSize: 11, fontWeight: '700', color: colors.white },
  imagePlaceholder: {
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  placeholderText: { fontSize: 12, color: colors.mochaBrown },

  variantThumb: {
    width: 54,
    height: 54,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: 'rgba(140,111,86,0.08)',
  },
  variantThumbActive: { borderColor: colors.pointOrange },
  variantIndex: {
    position: 'absolute',
    bottom: 3,
    right: 5,
    fontSize: 9.5,
    fontWeight: '800',
    color: colors.white,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 3,
  },

  overlayRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  overlayLabel: { fontSize: 11.5, fontWeight: '700', color: colors.mochaBrown, marginRight: 2 },
  overlayChip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(140,111,86,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(140,111,86,0.18)',
  },
  overlayChipActive: { backgroundColor: colors.espressoBrown, borderColor: colors.espressoBrown },
  overlayText: { fontSize: 11, fontWeight: '700', color: colors.mochaBrown },
  overlayTextActive: { color: colors.white },

  redoRow: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 4 },
  redoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(140,111,86,0.09)',
  },
  redoText: { fontSize: 11.5, fontWeight: '700', color: colors.espressoBrown },

  headlineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 8 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  copyIcon: { padding: 6 },

  headline: { fontSize: 19, fontWeight: '900', color: colors.espressoBrown, letterSpacing: -0.4 },
  subHeadline: { fontSize: 13, color: colors.mochaBrown, marginTop: 4, fontWeight: '600' },
  bodyText: { fontSize: 13.5, color: colors.espressoBrown, lineHeight: 21 },

  hashtagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  hashtagChip: {
    backgroundColor: 'rgba(226,130,87,0.12)',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  hashtagText: { fontSize: 11.5, color: colors.pointOrange, fontWeight: '700' },

  tipBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: 'rgba(140,111,86,0.08)',
    borderRadius: 10,
    padding: 10,
    marginTop: 12,
  },
  tipText: { flex: 1, fontSize: 12, color: colors.espressoBrown, lineHeight: 17 },

  actionRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  providerNote: {
    fontSize: 10.5,
    color: colors.mochaBrown,
    textAlign: 'center',
    marginTop: 8,
  },

  sheetTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: colors.espressoBrown,
    marginBottom: 4,
  },
  sheetHint: { fontSize: 11.5, color: colors.mochaBrown, marginBottom: 12, lineHeight: 16 },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
  },
  shareIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(140,111,86,0.1)',
  },
  shareTitle: { fontSize: 13.5, fontWeight: '800', color: colors.espressoBrown },
  shareDesc: { fontSize: 11, color: colors.mochaBrown, marginTop: 2 },

  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  historyThumb: { width: 44, height: 44, borderRadius: 10 },
  historyThumbEmpty: {
    backgroundColor: 'rgba(140,111,86,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyTitle: { fontSize: 13.5, fontWeight: '700', color: colors.espressoBrown },
  historyMeta: { fontSize: 11, color: colors.mochaBrown, marginTop: 2 },
  deleteBtn: { padding: 8 },
});
