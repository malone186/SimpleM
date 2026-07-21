// 📡 [한글 주석: 매장 센서 스테이션 — 스마트홈 기기 페어링 컨셉의 센서 연동 마법사]
// 기기별 설치 가이드 → '기기 스캔'(신호 감지 애니메이션) → 시리얼 발급·페어링 완료.
// 센서를 하나씩 연결할 때마다 발주 화면의 해당 지표가 데모→실측(LIVE)으로 승격된다.
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, typography } from '../../theme';
import {
  getSensorDevices,
  pairSensorDevice,
  unpairSensorDevice,
  SensorDevice,
} from '../../lib/api/sensor';

interface Props {
  visible: boolean;
  token: string | null;
  initialDeviceId?: string | null; // 설비 칩에서 특정 센서로 바로 진입할 때
  onClose: () => void;
  onPairingChanged: () => void;    // 페어링 변경 → 부모가 라이브 스냅샷 즉시 갱신
  onDisableFeature?: () => void;   // '우리 매장엔 센서가 없어요' — 기능 전체 끄기
}

export default function SensorSetupModal({
  visible, token, initialDeviceId, onClose, onPairingChanged, onDisableFeature,
}: Props) {
  const [devices, setDevices] = useState<SensorDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [justPairedId, setJustPairedId] = useState<string | null>(null);

  // 진행 게이지 애니메이션
  const progressAnim = useRef(new Animated.Value(0)).current;

  const pairedCount = devices.filter((d) => d.paired).length;
  const total = devices.length || 6;
  const allDone = devices.length > 0 && pairedCount === total;

  const loadDevices = async () => {
    if (!token) return;
    try {
      setLoading(true);
      const res = await getSensorDevices(token);
      setDevices(res.devices);
    } catch {
      // 백엔드 미기동 시 목록 없이 안내만 노출
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible) {
      loadDevices();
      setExpandedId(initialDeviceId ?? null);
      setJustPairedId(null);
    }
  }, [visible, initialDeviceId]);

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: total > 0 ? pairedCount / total : 0,
      duration: 500,
      useNativeDriver: false,
    }).start();
  }, [pairedCount, total]);

  // '기기 스캔' — 1.8초 신호 감지 연출 후 실제 페어링 API 호출
  const handleScan = async (device: SensorDevice) => {
    if (!token || scanningId) return;
    setScanningId(device.id);
    await new Promise((r) => setTimeout(r, 1800));
    try {
      await pairSensorDevice(token, device.id);
      setJustPairedId(device.id);
      await loadDevices();
      onPairingChanged();
    } catch {
      // 실패 시 조용히 스캔 상태만 해제 (재시도 가능)
    } finally {
      setScanningId(null);
    }
  };

  const handleUnpair = async (device: SensorDevice) => {
    if (!token) return;
    try {
      await unpairSensorDevice(token, device.id);
      setJustPairedId(null);
      await loadDevices();
      onPairingChanged();
    } catch { }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.root}>
        <TouchableOpacity style={s.backdrop} onPress={onClose} />
        <View style={s.sheet}>
          <View style={s.handle} />

          {/* 헤더 + 진행 게이지 */}
          <View style={s.headerRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Ionicons name="hardware-chip-outline" size={18} color={colors.espressoBrown} />
              <Text style={s.title}>매장 센서 스테이션</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
              <Ionicons name="close" size={20} color={colors.espressoBrown} />
            </TouchableOpacity>
          </View>

          <View style={s.progressBlock}>
            <View style={s.progressLabelRow}>
              <Text style={s.progressLabel}>
                {allDone ? '모든 센서 연결 완료!' : `센서 ${pairedCount}/${total} 연결됨`}
              </Text>
              <Text style={s.progressPercent}>{Math.round((pairedCount / total) * 100)}%</Text>
            </View>
            <View style={s.progressTrack}>
              <Animated.View
                style={[s.progressFill, {
                  width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                  backgroundColor: allDone ? '#2E7D32' : colors.mochaBrown,
                }]}
              />
            </View>
            <Text style={s.progressHint}>
              {allDone
                ? '발주 화면의 모든 수치가 실측(LIVE)으로 표시돼요.'
                : '센서를 하나 연결할 때마다 해당 수치가 데모 → 실측으로 바뀌어요.'}
            </Text>
          </View>

          {loading && devices.length === 0 ? (
            <View style={{ paddingVertical: 30, alignItems: 'center' }}>
              <ActivityIndicator color={colors.mochaBrown} />
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 16 }}>
              {devices.map((device) => {
                const isExpanded = expandedId === device.id;
                const isScanning = scanningId === device.id;
                const justPaired = justPairedId === device.id;
                return (
                  <View key={device.id} style={[s.deviceCard, device.paired && s.deviceCardPaired]}>
                    {/* 기기 요약 행 */}
                    <TouchableOpacity
                      style={s.deviceRow}
                      onPress={() => setExpandedId(isExpanded ? null : device.id)}
                      activeOpacity={0.7}
                    >
                      <View style={[s.deviceIconCircle, device.paired && s.deviceIconCirclePaired]}>
                        <Ionicons
                          name={device.icon as any}
                          size={16}
                          color={device.paired ? '#2E7D32' : colors.mochaBrown}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.deviceName}>{device.name}</Text>
                        <Text style={s.deviceWhere} numberOfLines={1}>
                          {device.paired && device.serial ? `${device.serial} · 연결됨` : device.where}
                        </Text>
                      </View>
                      {device.paired ? (
                        <View style={s.pairedChip}>
                          <Ionicons name="checkmark-circle" size={11} color="#2E7D32" />
                          <Text style={s.pairedChipText}>실측 중</Text>
                        </View>
                      ) : (
                        <View style={s.unpairedChip}>
                          <Text style={s.unpairedChipText}>연결하기</Text>
                          <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={11} color={colors.mochaBrown} />
                        </View>
                      )}
                    </TouchableOpacity>

                    {/* 펼침: 효과 + 설치 가이드 + 스캔 버튼 */}
                    {isExpanded && (
                      <View style={s.guideBox}>
                        <View style={s.benefitRow}>
                          <Ionicons name="sparkles-outline" size={12} color={colors.espressoBrown} />
                          <Text style={s.benefitText}>{device.benefit}</Text>
                        </View>
                        <Text style={s.modelText}>권장 장비: {device.model}</Text>

                        {device.steps.map((step, i) => (
                          <View key={i} style={s.stepRow}>
                            <View style={s.stepNum}>
                              <Text style={s.stepNumText}>{i + 1}</Text>
                            </View>
                            <Text style={s.stepText}>{step}</Text>
                          </View>
                        ))}

                        {device.paired ? (
                          <View style={s.pairedActions}>
                            {justPaired && (
                              <View style={s.successBanner}>
                                <Ionicons name="checkmark-circle" size={14} color="#2E7D32" />
                                <Text style={s.successBannerText}>
                                  {device.serial} 페어링 완료 — 지금부터 실측값이에요!
                                </Text>
                              </View>
                            )}
                            <TouchableOpacity onPress={() => handleUnpair(device)} style={s.unpairBtn}>
                              <Text style={s.unpairBtnText}>연결 해제</Text>
                            </TouchableOpacity>
                          </View>
                        ) : (
                          <TouchableOpacity
                            style={[s.scanBtn, isScanning && { opacity: 0.85 }]}
                            onPress={() => handleScan(device)}
                            disabled={isScanning}
                            activeOpacity={0.8}
                          >
                            {isScanning ? (
                              <>
                                <ActivityIndicator size="small" color={colors.white} />
                                <Text style={s.scanBtnText}>신호 감지 중… 허브 주변 기기를 찾고 있어요</Text>
                              </>
                            ) : (
                              <>
                                <Ionicons name="bluetooth-outline" size={14} color={colors.white} />
                                <Text style={s.scanBtnText}>기기 스캔</Text>
                              </>
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    )}
                  </View>
                );
              })}

              {devices.length === 0 && !loading && (
                <View style={s.offlineBox}>
                  <Ionicons name="cloud-offline-outline" size={22} color={colors.stone300} />
                  <Text style={s.offlineText}>
                    센서 허브 서버에 연결할 수 없어요.{'\n'}백엔드가 켜져 있는지 확인해 주세요.
                  </Text>
                </View>
              )}

              {/* 센서가 아예 없는 매장을 위한 기능 전체 끄기 (배너·알림도 함께 사라짐) */}
              {onDisableFeature && (
                <TouchableOpacity style={s.disableRow} onPress={onDisableFeature} activeOpacity={0.7}>
                  <Ionicons name="power-outline" size={12} color={colors.stone300} />
                  <Text style={s.disableRowText}>
                    우리 매장엔 센서가 없어요 — 센서 기능 끄기
                  </Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center' as const,
  },
  backdrop: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: colors.creamSand,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 28,
    maxHeight: '88%',
  },
  handle: {
    width: 40, height: 4, borderRadius: 999,
    backgroundColor: colors.stone300,
    alignSelf: 'center', marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 10,
  },
  title: { ...typography.L1, fontSize: 17, color: colors.espressoBrown },

  // 진행 게이지
  progressBlock: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.mutedSand,
  },
  progressLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  progressLabel: { fontSize: 12, fontWeight: '800', color: colors.espressoBrown },
  progressPercent: { fontSize: 12, fontWeight: '800', color: colors.mochaBrown },
  progressTrack: {
    height: 7, borderRadius: 4, backgroundColor: colors.coffeeCream, overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 4 },
  progressHint: { fontSize: 10, color: colors.mochaBrown, marginTop: 6, lineHeight: 14 },

  // 기기 카드
  deviceCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.mutedSand,
    overflow: 'hidden',
  },
  deviceCardPaired: {
    borderColor: '#C8E6C9',
    backgroundColor: '#FBFEFB',
  },
  deviceRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12,
  },
  deviceIconCircle: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(140, 111, 86, 0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  deviceIconCirclePaired: { backgroundColor: '#E8F5E9' },
  deviceName: { fontSize: 13, fontWeight: '800', color: colors.espressoBrown },
  deviceWhere: { fontSize: 10, color: colors.stone300, marginTop: 1 },

  pairedChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#E8F5E9', borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  pairedChipText: { fontSize: 10, fontWeight: '800', color: '#2E7D32' },
  unpairedChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: colors.coffeeCream, borderRadius: 999,
    paddingHorizontal: 9, paddingVertical: 4,
  },
  unpairedChipText: { fontSize: 10, fontWeight: '800', color: colors.mochaBrown },

  // 설치 가이드
  guideBox: {
    borderTopWidth: 1, borderTopColor: colors.coffeeCream,
    padding: 12, gap: 7,
  },
  benefitRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 5,
    backgroundColor: 'rgba(140, 111, 86, 0.06)',
    borderRadius: 8, padding: 8,
  },
  benefitText: { flex: 1, fontSize: 11, fontWeight: '700', color: colors.espressoBrown, lineHeight: 15 },
  modelText: { fontSize: 10, color: colors.stone300, fontWeight: '600' },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  stepNum: {
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  stepNumText: { fontSize: 9, fontWeight: '800', color: colors.mochaBrown },
  stepText: { flex: 1, fontSize: 11, color: colors.mochaBrown, lineHeight: 16 },

  scanBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.espressoBrown,
    borderRadius: 10, paddingVertical: 11, marginTop: 4,
  },
  scanBtnText: { fontSize: 12, fontWeight: '800', color: colors.white },

  pairedActions: { gap: 8, marginTop: 2 },
  successBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#E8F5E9', borderRadius: 8, padding: 8,
  },
  successBannerText: { flex: 1, fontSize: 11, fontWeight: '700', color: '#2E7D32' },
  unpairBtn: { alignSelf: 'flex-end', paddingVertical: 2, paddingHorizontal: 4 },
  unpairBtnText: { fontSize: 10, fontWeight: '700', color: colors.stone300, textDecorationLine: 'underline' },

  offlineBox: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  offlineText: { fontSize: 11, color: colors.stone300, textAlign: 'center', lineHeight: 16 },

  disableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 10,
    marginTop: 4,
  },
  disableRowText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.stone300,
    textDecorationLine: 'underline',
  },
});
