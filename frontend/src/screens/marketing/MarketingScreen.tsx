// 홍보 스튜디오 (백엔드 B) — AI 홍보 문구 + 고품질 홍보 이미지 자동 생성
//
// 흐름: 채널·주제 입력 → [홍보물 만들기] → ① 문구 생성(매장 실데이터 근거) →
//       ② 그 문구에 맞는 이미지 자동 생성 → 결과 카드(이미지·캡션·해시태그·팁) + 공유.
// 이미지는 서버가 Gemini(유료 키) → Pollinations(무료) 순으로 알아서 만든다.
// 지난 홍보물은 보관함(문서 kind=marketing_content)에서 다시 열어볼 수 있다.
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthContext';
import { PressableScale } from '../../components/motion';
import { toast } from '../../components/toast';
import { Button, Card, Divider, Screen, SectionTitle } from '../../components/ui';
import { describeApiFailure } from '../../lib/api/errors';
import {
  CHANNEL_META,
  aspectToNumber,
  createPromotionCopy,
  createPromotionImage,
  deletePromotion,
  listPromotions,
  promoImageUrl,
  type PromotionChannel,
  type PromotionDoc,
} from '../../lib/api/marketing';
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
type Phase = 'idle' | 'copy' | 'image';

/** 클립보드 복사 — 웹은 바로 복사, 앱은 클립보드 모듈이 없어 공유 시트로 대신한다 */
async function copyOrShare(text: string, label: string) {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      toast('📋 복사 완료', `${label}이(가) 클립보드에 복사됐어요.`);
      return;
    } catch {
      // 권한 거부 등 — 공유 시트로 폴백
    }
  }
  try {
    await Share.share({ message: text });
  } catch {
    // 사용자가 공유 시트를 닫음 — 아무것도 안 함
  }
}

export default function MarketingScreen() {
  const { token } = useAuth();

  // 입력 폼
  const [channel, setChannel] = useState<PromotionChannel>('instagram');
  const [topic, setTopic] = useState('');
  const [tone, setTone] = useState('');
  const [menu, setMenu] = useState('');
  const [imageStyle, setImageStyle] = useState(''); // IMAGE_STYLES의 key (빈 값 = 자동)

  // 생성 상태·결과
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<PromotionDoc | null>(null);

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

  /** 문구 → 이미지 순서로 자동 생성. 문구가 나오는 즉시 화면에 먼저 보여준다. */
  const generate = async () => {
    if (!token) {
      toast('로그인이 필요해요', '로그인 후 홍보물을 만들 수 있습니다.');
      return;
    }
    if (phase !== 'idle') return;

    setPhase('copy');
    setResult(null);
    try {
      const doc = await createPromotionCopy(token, { topic, channel, tone, menu });
      setResult(doc); // 문구 먼저 표시 — 이미지는 아래에서 이어서

      setPhase('image');
      const img = await createPromotionImage(token, {
        doc_id: doc.id,
        style: imageStyle,
        aspect_ratio: CHANNEL_META[channel].aspect,
      });
      if (img.doc) setResult(img.doc);
      refreshHistory();
    } catch (e) {
      toast('홍보물 생성 실패', describeApiFailure(e, '홍보물').message);
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

  const c = result?.content;
  const image = c?.images?.length ? c.images[c.images.length - 1] : null;
  const hashtagLine = (c?.hashtags ?? []).join(' ');

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
          onPress={generate}
          disabled={phase !== 'idle'}
          style={{ marginTop: 14 }}
        />
        {phase !== 'idle' && (
          <View style={styles.progressRow}>
            <ActivityIndicator size="small" color={colors.pointOrange} />
            <Text style={styles.progressText}>
              {phase === 'copy'
                ? '매장 정보(베스트 메뉴·위치)를 바탕으로 작성하고 있어요'
                : '문구에 어울리는 고화질 이미지를 만들고 있어요 (10초 안팎)'}
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
              <Image
                source={{ uri: promoImageUrl(image.url) }}
                style={[styles.promoImage, { aspectRatio: aspectToNumber(image.aspect_ratio) }]}
                resizeMode="cover"
              />
            ) : phase === 'image' ? (
              <View style={[styles.promoImage, styles.imagePlaceholder]}>
                <ActivityIndicator color={colors.pointOrange} />
                <Text style={styles.placeholderText}>이미지 생성 중...</Text>
              </View>
            ) : null}

            <Text style={styles.headline}>{c.headline}</Text>
            {!!c.sub_headline && <Text style={styles.subHeadline}>{c.sub_headline}</Text>}

            <Divider style={{ marginVertical: 12 }} />

            <Text style={styles.fieldLabel}>
              {c.channel === 'sms' ? '문자 내용' : c.channel === 'instagram' ? '캡션' : '본문'}
            </Text>
            <Text style={styles.bodyText}>
              {c.channel === 'instagram' ? c.sns_caption : c.body}
            </Text>

            {c.hashtags?.length > 0 && (
              <>
                <Text style={[styles.fieldLabel, { marginTop: 12 }]}>해시태그</Text>
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
                label="문구 복사"
                variant="secondary"
                style={{ flex: 1 }}
                onPress={() =>
                  copyOrShare(
                    `${c.channel === 'instagram' ? c.sns_caption : c.body}\n\n${hashtagLine}`,
                    '문구'
                  )
                }
              />
              <Button
                label="공유하기"
                style={{ flex: 1 }}
                onPress={() =>
                  Share.share({
                    message: `${c.headline}\n\n${
                      c.channel === 'instagram' ? c.sns_caption : c.body
                    }\n\n${hashtagLine}`,
                  }).catch(() => {})
                }
              />
            </View>
            {image?.provider === 'pollinations' && (
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
                    onPress={() => setResult(doc)}
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
    </Screen>
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
    borderColor: 'rgba(60, 60, 67,0.25)',
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
  input: {
    backgroundColor: 'rgba(60, 60, 67,0.07)',
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
    backgroundColor: 'rgba(60, 60, 67,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(60, 60, 67,0.18)',
  },
  styleChipActive: {
    backgroundColor: colors.pointOrange,
    borderColor: colors.pointOrange,
  },
  styleText: { fontSize: 11.5, fontWeight: '700', color: colors.mochaBrown },
  styleTextActive: { color: colors.white },

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
    backgroundColor: 'rgba(60, 60, 67,0.08)',
  },
  imagePlaceholder: {
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  placeholderText: { fontSize: 12, color: colors.mochaBrown },

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
    backgroundColor: 'rgba(60, 60, 67,0.08)',
    borderRadius: 10,
    padding: 10,
    marginTop: 12,
  },
  tipText: { flex: 1, fontSize: 12, color: colors.espressoBrown, lineHeight: 17 },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  providerNote: {
    fontSize: 10.5,
    color: colors.mochaBrown,
    textAlign: 'center',
    marginTop: 8,
  },

  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  historyThumb: { width: 44, height: 44, borderRadius: 10 },
  historyThumbEmpty: {
    backgroundColor: 'rgba(60, 60, 67,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyTitle: { fontSize: 13.5, fontWeight: '700', color: colors.espressoBrown },
  historyMeta: { fontSize: 11, color: colors.mochaBrown, marginTop: 2 },
  deleteBtn: { padding: 8 },
});
