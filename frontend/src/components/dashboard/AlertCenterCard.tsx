// [한글 주석: 아이폰 iOS 감성 부드러운 아코디언 펼침 & 180도 세모 회전 스마트 알림 센터]
import React, { useState, useRef, useEffect } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, shadows } from '../../theme';
import { PressableScale } from '../motion';
import { type PushTarget } from '../../notifications/navigationTarget';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export type AlertType = 'stock' | 'document' | 'sensor' | 'insight' | 'notice';
export type AlertSeverity = 'urgent' | 'high' | 'medium' | 'low';

export type AlertItem = {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  body: string;
  timeText?: string;
  actionText?: string;
  target?: PushTarget;
};

interface AlertCenterCardProps {
  alerts: AlertItem[];
  onPressAlert?: (alert: AlertItem) => void;
  onDismissAlert?: (id: string) => void;
  onClearAllAlerts?: () => void;
  onRestoreAlerts?: () => void;
  forceExpand?: boolean;
}

const ALERT_META: Record<
  AlertType,
  { label: string; icon: keyof typeof Ionicons.glyphMap; color: string; iconBg: string; chipBg: string }
> = {
  sensor: {
    label: '긴급 설비',
    icon: 'warning',
    color: '#E53E3E',
    iconBg: 'rgba(229, 62, 62, 0.12)',
    chipBg: 'rgba(229, 62, 62, 0.08)',
  },
  stock: {
    label: '재고 부족',
    icon: 'cube',
    color: '#DD6B20',
    iconBg: 'rgba(221, 107, 32, 0.12)',
    chipBg: 'rgba(221, 107, 32, 0.08)',
  },
  document: {
    label: '서류 갱신',
    icon: 'document-text',
    color: '#B7791F',
    iconBg: 'rgba(183, 121, 31, 0.12)',
    chipBg: 'rgba(183, 121, 31, 0.08)',
  },
  insight: {
    label: 'AI 인사이트',
    icon: 'sparkles',
    color: '#2F855A',
    iconBg: 'rgba(47, 133, 90, 0.12)',
    chipBg: 'rgba(47, 133, 90, 0.08)',
  },
  notice: {
    label: '시스템 알림',
    icon: 'notifications',
    color: '#3182CE',
    iconBg: 'rgba(49, 130, 206, 0.12)',
    chipBg: 'rgba(49, 130, 206, 0.08)',
  },
};

// [한글 주석: 아이폰 iOS 감성 순차 페이드인 & 슬라이드다운 애니메이션 카드]
function AnimatedAlertItem({
  item,
  index,
  onPress,
  onDismiss,
}: {
  item: AlertItem;
  index: number;
  onPress?: () => void;
  onDismiss?: () => void;
}) {
  const animVal = useRef(new Animated.Value(0)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const dismissOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // [한글 주석: 위에서 아래로 스르륵 내려오는 순차 페이드인]
    Animated.timing(animVal, {
      toValue: 1,
      duration: 300,
      delay: index * 40,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);

  const handleDismiss = () => {
    Animated.parallel([
      Animated.timing(translateX, {
        toValue: 380,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(dismissOpacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onDismiss?.();
    });
  };

  const translateY = animVal.interpolate({
    inputRange: [0, 1],
    outputRange: [-10, 0],
  });

  const meta = ALERT_META[item.type] || ALERT_META.notice;

  return (
    <Animated.View
      style={{
        transform: [{ translateY }, { translateX }],
        opacity: Animated.multiply(animVal, dismissOpacity),
      }}
    >
      <PressableScale style={styles.alertCard} onPress={onPress}>
        <View style={styles.alertCardRow}>
          <View style={[styles.squircleIconBox, { backgroundColor: meta.iconBg }]}>
            <Ionicons name={meta.icon} size={19} color={meta.color} />
          </View>

          <View style={styles.alertContentCol}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.alertTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <View style={[styles.typePillTag, { backgroundColor: meta.chipBg }]}>
                <Text style={[styles.typePillText, { color: meta.color }]}>{meta.label}</Text>
              </View>
            </View>

            <Text style={styles.alertBody} numberOfLines={1}>
              {item.body}
            </Text>

            <View style={styles.alertFooterRow}>
              <View style={styles.actionLinkRow}>
                <Text style={[styles.actionLinkText, { color: meta.color }]}>
                  {item.actionText || '바로 확인'}
                </Text>
                <Ionicons name="arrow-forward-outline" size={12} color={meta.color} />
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {item.timeText && <Text style={styles.timeText}>{item.timeText}</Text>}

                {onDismiss && (
                  <Pressable
                    style={styles.dismissBtn}
                    onPress={(e) => {
                      e.stopPropagation();
                      handleDismiss();
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close" size={15} color="#A1A1AA" />
                  </Pressable>
                )}
              </View>
            </View>
          </View>
        </View>
      </PressableScale>
    </Animated.View>
  );
}

export default function AlertCenterCard({
  alerts = [],
  onPressAlert,
  onDismissAlert,
  onClearAllAlerts,
  onRestoreAlerts,
  forceExpand = false,
}: AlertCenterCardProps) {
  const [isExpanded, setIsExpanded] = useState(forceExpand);
  const rotateAnim = useRef(new Animated.Value(forceExpand ? 1 : 0)).current;
  const hasAlerts = alerts.length > 0;

  const topAlert = alerts[0];
  const secondAlert = alerts[1];

  // [한글 주석: 세모 화살표 180도 부드러운 회전 및 레이아웃 아코디언 애니메이션]
  const toggleExpand = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const nextState = !isExpanded;
    setIsExpanded(nextState);

    Animated.timing(rotateAnim, {
      toValue: nextState ? 1 : 0,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  const arrowRotate = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });

  return (
    <View style={styles.container}>
      {/* ━━━ [한글 주석: 헤더 바 — 스마트 알림 센터 + 세모 화살표 회전 버튼] ━━━ */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          {!forceExpand && <Text style={styles.headerTitle}>스마트 알림 센터</Text>}
          {alerts.length > 0 && (
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{alerts.length}개 알림</Text>
            </View>
          )}
        </View>

        <View style={styles.headerActionRow}>
          {hasAlerts && onClearAllAlerts && isExpanded && (
            <Pressable style={styles.clearAllBtn} onPress={onClearAllAlerts}>
              <Text style={styles.clearAllText}>모두 지우기</Text>
            </Pressable>
          )}


          {/* [한글 주석: 아이폰 iOS 감성 세모 화살표 180도 회전 버튼 — forceExpand 모드에서는 사장님 요청으로 숨김] */}
          {hasAlerts && !forceExpand && (
            <PressableScale style={styles.toggleBtn} onPress={toggleExpand} to={0.92}>
              <Animated.View style={{ transform: [{ rotate: arrowRotate }] }}>
                <Ionicons name="chevron-down-circle" size={24} color={colors.espressoBrown} />
              </Animated.View>
            </PressableScale>
          )}
        </View>
      </View>

      {/* ━━━ [한글 주석: 접힘 (Overlapping Stack Deck) vs 펼침 (Full List Animation)] ━━━ */}
      {!hasAlerts ? (
        <View style={styles.emptyCard}>
          <View style={styles.emptyIconCircle}>
            <Ionicons name="checkmark-circle-outline" size={24} color="#38A169" />
          </View>
          <View style={styles.emptyTextCol}>
            <Text style={styles.emptyTitle}>지금 확인할 알림이 없어요</Text>
            <Text style={styles.emptySubtitle}>재고·서류에 문제가 생기면 여기에 바로 알려드려요</Text>
          </View>
          {onRestoreAlerts && (
            <Pressable style={styles.restoreBtn} onPress={onRestoreAlerts} hitSlop={6}>
              <Text style={styles.restoreText}>지운 알림 보기</Text>
            </Pressable>
          )}
        </View>
      ) : !isExpanded ? (
        /* ━━━ [한글 주석: 접혀있을 때 — 입체적인 겹겹이 스택 카드] ━━━ */
        <Pressable style={styles.stackWrapper} onPress={toggleExpand}>
          <AnimatedAlertItem
            item={topAlert}
            index={0}
            onPress={() => onPressAlert?.(topAlert)}
            onDismiss={() => onDismissAlert?.(topAlert.id)}
          />
        </Pressable>
      ) : (
        /* ━━━ [한글 주석: 펼쳐졌을 때 — 아이폰 순차 애니메이션 리스트] ━━━ */
        <View style={styles.alertList}>
          {alerts.map((item, idx) => (
            <AnimatedAlertItem
              key={item.id}
              item={item}
              index={idx}
              onPress={() => onPressAlert?.(item)}
              onDismiss={() => onDismissAlert?.(item.id)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(230, 224, 216, 0.9)',
    ...shadows.medium,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.espressoBrown,
  },
  countBadge: {
    backgroundColor: colors.pointOrange,
    paddingHorizontal: 7,
    paddingVertical: 1.5,
    borderRadius: 10,
  },
  countBadgeText: {
    fontSize: 10.5,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  headerActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  clearAllBtn: {
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
  clearAllText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: '#71717A',
  },
  restoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(140, 111, 86, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  restoreText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.mochaBrown,
  },
  toggleBtn: {
    padding: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FAF8F5',
    borderRadius: 18,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: '#EFEAE2',
  },
  emptyIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(56, 161, 105, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTextCol: {
    flex: 1,
  },
  emptyTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.espressoBrown,
    marginBottom: 1,
  },
  emptySubtitle: {
    fontSize: 11,
    color: colors.mochaBrown,
  },
  stackWrapper: {
    position: 'relative',
  },
  stackLayerBack: {
    position: 'absolute',
    top: -8,
    left: 10,
    right: 10,
    height: 40,
    backgroundColor: '#EFEAE2',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingTop: 4,
    borderWidth: 1,
    borderColor: '#E2D9CD',
    opacity: 0.85,
  },
  stackLayerBackText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.mochaBrown,
  },
  stackHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 8,
    paddingVertical: 4,
  },
  stackHintText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.mochaBrown,
  },
  alertList: {
    gap: 10,
  },
  alertCard: {
    backgroundColor: '#FAF8F5',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#EFEAE2',
    paddingHorizontal: 13,
    paddingVertical: 11,
    ...shadows.soft,
  },
  alertCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  squircleIconBox: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertContentCol: {
    flex: 1,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  alertTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.espressoBrown,
    flex: 1,
    marginRight: 6,
  },
  typePillTag: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
  },
  typePillText: {
    fontSize: 10,
    fontWeight: '700',
  },
  alertBody: {
    fontSize: 11.5,
    color: '#4A5568',
    lineHeight: 15.5,
    marginBottom: 6,
  },
  alertFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: 'rgba(230, 224, 216, 0.6)',
    paddingTop: 5,
  },
  actionLinkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  actionLinkText: {
    fontSize: 11,
    fontWeight: '700',
  },
  timeText: {
    fontSize: 10,
    color: '#A1A1AA',
  },
  dismissBtn: {
    padding: 2,
  },
});
