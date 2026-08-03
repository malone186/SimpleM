// 📡 [한글 주석: 매장 센서 스테이션 — 실제 BLE 스캔 기반 센서 연동 마법사]
// 기기별 설치 가이드 → '기기 스캔'(진짜 블루투스 스캔) → 발견 기기 선택 → 페어링.
// 웹(Chrome)은 Web Bluetooth 선택창, 네이티브(개발 빌드)는 ble-plx 스캔을 쓴다.
// 실물 센서가 없는 매장을 위해 '데모로 연결' 폴백도 남겨둔다.
// 센서를 하나씩 연결할 때마다 발주 화면의 해당 지표가 데모→실측(LIVE)으로 승격된다.
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '../../i18n/translations';
import { colors, typography } from '../../theme';
import {
  getSensorDevices,
  pairSensorDevice,
  unpairSensorDevice,
  SensorDevice,
} from '../../lib/api/sensor';
import { getBleAvailability, scanForBleDevices } from '../../lib/ble/bleScanner';
import { startBleLiveReader, stopBleLiveReader } from '../../lib/ble/bleLiveReader';
import { FoundBleDevice } from '../../lib/ble/bleTypes';

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
  // [한글 주석: 전역 다국어 훅 연결]
  const { t, language } = useTranslation();
  const [devices, setDevices] = useState<SensorDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [justPairedId, setJustPairedId] = useState<string | null>(null);
  const [foundDevices, setFoundDevices] = useState<FoundBleDevice[]>([]); // BLE 스캔 결과
  const [scanError, setScanError] = useState<string | null>(null);
  const [pairingBleId, setPairingBleId] = useState<string | null>(null);  // 페어링 진행 중인 BLE 기기
  const [storeId, setStoreId] = useState<string | null>(null);            // 실측 업링크용 매장 식별자

  // 진행 게이지 애니메이션
  const progressAnim = useRef(new Animated.Value(0)).current;

  // 기기 목록 수신
  const reloadDevices = async () => {
    if (!token) return;
    try {
      setLoading(true);
      const res = await getSensorDevices(token);
      setDevices(res.devices);
      setStoreId(res.store_id);
    } catch (err) {
      console.warn('센서 기기 목록 수신 오류:', err);
    } finally {
      setLoading(false);
    }
  };

  const pairedCount = devices.filter((d) => d.paired).length;
  const total = devices.length || 6;
  const allDone = devices.length > 0 && pairedCount === total;

  useEffect(() => {
    if (visible) {
      reloadDevices();
      setExpandedId(initialDeviceId ?? null);
      setJustPairedId(null);
      setFoundDevices([]);
      setScanError(null);
    }
  }, [visible, initialDeviceId]);

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: total > 0 ? pairedCount / total : 0,
      duration: 500,
      useNativeDriver: false,
    }).start();
  }, [pairedCount, total]);

  // '기기 스캔' — 진짜 블루투스 스캔.
  // 웹: 크롬 Web Bluetooth 선택창에서 실기기를 고르면 바로 페어링.
  // 네이티브(개발 빌드): 8초간 주변 BLE 광고를 수집해 목록으로 보여주고 탭해서 페어링.
  const handleScan = async (device: SensorDevice) => {
    if (!token || scanningId) return;
    setScanningId(device.id);
    setScanError(null);
    setFoundDevices([]);

    const avail = getBleAvailability();
    if (!avail.available) {
      setScanError(avail.reason);
      setScanningId(null);
      return;
    }
    try {
      const list = await scanForBleDevices({
        hints: device.ble_names ?? [],
        timeoutMs: 8000,
        onDevice: (d) =>
          setFoundDevices((prev) => (prev.some((p) => p.id === d.id) ? prev : [...prev, d])),
      });
      if (list.length === 0) {
        setScanError(
          Platform.OS === 'web'
            ? '기기를 선택하지 않았어요. 다시 스캔하거나, 실물 센서가 없다면 아래 데모 연결을 눌러주세요.'
            : '주변에서 블루투스 기기를 찾지 못했어요. 센서 허브 전원과 거리(3m 이내)를 확인해 주세요.',
        );
      } else if (Platform.OS === 'web') {
        // 웹은 브라우저 선택창에서 이미 기기를 골랐으므로 바로 페어링
        await handlePairBle(device, list[0]);
      } else {
        setFoundDevices(list);
      }
    } catch (e: any) {
      setScanError(e?.message || '스캔 중 오류가 발생했어요.');
    } finally {
      setScanningId(null);
    }
  };

  // 스캔으로 찾은 실기기를 서버에 등록 (실측 페어링)
  const handlePairBle = async (device: SensorDevice, ble: FoundBleDevice) => {
    if (!token || pairingBleId) return;
    setPairingBleId(ble.id);
    try {
      await pairSensorDevice(token, device.id, {
        ble_id: ble.id,
        ble_name: ble.name,
        ...(ble.rssi != null ? { rssi: ble.rssi } : {}),
      });
      // 기기가 측정값 GATT(자체 허브 JSON·샤오미 온도계)를 지원하면 즉시 실측 수신 시작
      if (storeId) {
        startBleLiveReader({ store: storeId, catalogId: device.id, bleId: ble.id, bleName: ble.name });
      }
      setJustPairedId(device.id);
      setFoundDevices([]);
      setScanError(null);
      await reloadDevices();
      onPairingChanged();
    } catch {
      setScanError('페어링에 실패했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setPairingBleId(null);
    }
  };

  // 실물 센서가 없는 매장용 폴백 — 데모 데이터로 등록
  const handlePairDemo = async (device: SensorDevice) => {
    if (!token || scanningId || pairingBleId) return;
    try {
      await pairSensorDevice(token, device.id);
      setJustPairedId(device.id);
      setFoundDevices([]);
      setScanError(null);
      await reloadDevices();
      onPairingChanged();
    } catch { }
  };

  const handleUnpair = async (device: SensorDevice) => {
    if (!token) return;
    try {
      stopBleLiveReader(device.id); // 실측 수신 중이면 GATT 연결부터 끊는다
      await unpairSensorDevice(token, device.id);
      setJustPairedId(null);
      await reloadDevices();
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
                          {device.paired && device.serial
                            ? `${device.serial} · ${device.source === 'ble' ? (device.ble_name ?? '실기기') : '데모'} 연결됨`
                            : device.where}
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
                                  {device.source === 'ble'
                                    ? `${device.ble_name ?? '실기기'} (${device.serial}) 페어링 완료 — 지금부터 실측값이에요!`
                                    : `${device.serial} 데모 페어링 완료 — 실물 센서 연결 시 실측으로 전환돼요.`}
                                </Text>
                              </View>
                            )}
                            <TouchableOpacity onPress={() => handleUnpair(device)} style={s.unpairBtn}>
                              <Text style={s.unpairBtnText}>연결 해제</Text>
                            </TouchableOpacity>
                          </View>
                        ) : (
                          <>
                            <TouchableOpacity
                              style={[s.scanBtn, isScanning && { opacity: 0.85 }]}
                              onPress={() => handleScan(device)}
                              disabled={isScanning || !!pairingBleId}
                              activeOpacity={0.8}
                            >
                              {isScanning ? (
                                <>
                                  <ActivityIndicator size="small" color={colors.white} />
                                  <Text style={s.scanBtnText}>
                                    {Platform.OS === 'web'
                                      ? '브라우저 창에서 기기를 선택해 주세요…'
                                      : '주변 블루투스 기기 검색 중… (8초)'}
                                  </Text>
                                </>
                              ) : (
                                <>
                                  <Ionicons name="bluetooth-outline" size={14} color={colors.white} />
                                  <Text style={s.scanBtnText}>블루투스 기기 스캔</Text>
                                </>
                              )}
                            </TouchableOpacity>

                            {/* 스캔으로 발견한 실기기 목록 (네이티브) — 탭해서 페어링 */}
                            {isExpanded && foundDevices.length > 0 && (
                              <View style={s.foundList}>
                                <Text style={s.foundListTitle}>
                                  발견된 기기 {foundDevices.length}대 — 탭해서 연결
                                </Text>
                                {foundDevices.map((f) => (
                                  <TouchableOpacity
                                    key={f.id}
                                    style={[s.foundRow, f.hintMatch && s.foundRowHint]}
                                    onPress={() => handlePairBle(device, f)}
                                    disabled={!!pairingBleId}
                                    activeOpacity={0.7}
                                  >
                                    <Ionicons
                                      name="bluetooth"
                                      size={13}
                                      color={f.hintMatch ? '#2E7D32' : colors.mochaBrown}
                                    />
                                    <View style={{ flex: 1 }}>
                                      <Text style={s.foundName}>{f.name}</Text>
                                      <Text style={s.foundMeta} numberOfLines={1}>
                                        {f.id}{f.rssi != null ? ` · ${f.rssi}dBm` : ''}
                                      </Text>
                                    </View>
                                    {f.hintMatch && (
                                      <View style={s.hintChip}>
                                        <Text style={s.hintChipText}>권장 기기</Text>
                                      </View>
                                    )}
                                    {pairingBleId === f.id && (
                                      <ActivityIndicator size="small" color={colors.mochaBrown} />
                                    )}
                                  </TouchableOpacity>
                                ))}
                              </View>
                            )}

                            {isExpanded && scanError && (
                              <Text style={s.scanErrorText}>{scanError}</Text>
                            )}

                            {/* 실물 센서 미보유 매장용 폴백 */}
                            <TouchableOpacity
                              style={s.demoLink}
                              onPress={() => handlePairDemo(device)}
                              activeOpacity={0.7}
                            >
                              <Text style={s.demoLinkText}>
                                실물 센서가 아직 없어요 — 데모 데이터로 연결
                              </Text>
                            </TouchableOpacity>
                          </>
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

  // BLE 스캔 결과 목록
  foundList: {
    backgroundColor: 'rgba(140, 111, 86, 0.05)',
    borderRadius: 10, padding: 8, gap: 6, marginTop: 6,
  },
  foundListTitle: { fontSize: 10, fontWeight: '800', color: colors.mochaBrown },
  foundRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.white, borderRadius: 8,
    borderWidth: 1, borderColor: colors.mutedSand,
    paddingHorizontal: 10, paddingVertical: 8,
  },
  foundRowHint: { borderColor: '#C8E6C9', backgroundColor: '#FBFEFB' },
  foundName: { fontSize: 12, fontWeight: '800', color: colors.espressoBrown },
  foundMeta: { fontSize: 9, color: colors.stone300, marginTop: 1 },
  hintChip: {
    backgroundColor: '#E8F5E9', borderRadius: 999,
    paddingHorizontal: 7, paddingVertical: 3,
  },
  hintChipText: { fontSize: 9, fontWeight: '800', color: '#2E7D32' },
  scanErrorText: {
    fontSize: 10, color: '#C62828', lineHeight: 14, marginTop: 6,
  },
  demoLink: { alignItems: 'center', paddingVertical: 8, marginTop: 2 },
  demoLinkText: {
    fontSize: 10, fontWeight: '600', color: colors.stone300,
    textDecorationLine: 'underline',
  },

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
