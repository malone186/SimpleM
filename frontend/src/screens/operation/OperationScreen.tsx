// 운영 (프론트 B) — PRD ERP-9(스케줄·급여·정산), ERP-10(세금), AI-4(스케줄 추천)
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Badge, Button, Card, Divider, Screen, ScreenTitle, SectionTitle } from '../../components/ui';
import { Segmented } from '../../components/ui/Segmented';
import { toast } from '../../components/toast';
import { colors, typography } from '../../theme';

type Tab = 'schedule' | 'tax';

const notify = (title: string, message: string) => toast(title, message);

const STAFF = [
  { name: '김바리', role: '바리스타', hours: 32, wage: 11000 },
  { name: '이알바', role: '홀', hours: 20, wage: 10030 },
  { name: '박주말', role: '주말', hours: 16, wage: 10500 },
];

const SHIFTS = [
  { day: '월', slot: '09–15', who: '김바리', peak: false },
  { day: '화', slot: '09–15', who: '김바리', peak: false },
  { day: '금', slot: '13–21', who: '이알바', peak: true },
  { day: '토', slot: '11–20', who: '박주말', peak: true },
];

export default function OperationScreen() {
  const [tab, setTab] = useState<Tab>('schedule');

  return (
    <Screen>
      <ScreenTitle title="운영" subtitle="스케줄·급여와 세금을 한 곳에서" />

      {/* 슬라이딩 세그먼트 탭 */}
      <Segmented<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'schedule', label: '스케줄 · 급여' },
          { value: 'tax', label: '세금' },
        ]}
      />

      {tab === 'schedule' ? <ScheduleTab /> : <TaxTab />}
    </Screen>
  );
}

function ScheduleTab() {
  return (
    <>
      {/* AI 스케줄 추천 (AI-4) */}
      <Card tone="cream">
        <View style={styles.rowBetween}>
          <SectionTitle>AI 스케줄 추천</SectionTitle>
          <Badge label="초안" tone="orange" />
        </View>
        <Text style={styles.hint}>
          금·토 14–15시가 피크예요. 주말 오후에 1명 추가 배치를 추천해요.
        </Text>
        <View style={styles.actions}>
          <Button
            label="추천 반영"
            style={{ flex: 1 }}
            onPress={() => notify('스케줄 반영', '주말 오후 1명 추가 배치를 이번 주 스케줄 초안에 반영했어요.')}
          />
          <Button
            label="나중에"
            variant="secondary"
            style={{ flex: 1 }}
            onPress={() => notify('보류', '이 추천은 다음에 다시 알려드릴게요.')}
          />
        </View>
      </Card>

      {/* 주간 스케줄 */}
      <View style={{ gap: 10 }}>
        <SectionTitle>이번 주 스케줄</SectionTitle>
        {SHIFTS.map((s, i) => (
          <Card key={i}>
            <View style={styles.shiftRow}>
              <View style={styles.dayChip}>
                <Text style={styles.dayText}>{s.day}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.shiftWho}>{s.who}</Text>
                <Text style={styles.shiftSlot}>{s.slot}</Text>
              </View>
              {s.peak && <Badge label="피크" tone="green" />}
              <Ionicons name="create-outline" size={18} color={colors.mochaBrown} />
            </View>
          </Card>
        ))}
      </View>

      {/* 급여 요약 */}
      <Card>
        <SectionTitle>이번 달 급여</SectionTitle>
        <View style={{ marginTop: 12, gap: 10 }}>
          {STAFF.map((p) => (
            <View key={p.name} style={styles.payRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.payName}>{p.name}</Text>
                <Text style={styles.paySub}>{p.role} · {p.hours}h · ₩{p.wage.toLocaleString()}/h</Text>
              </View>
              <Text style={styles.payAmount}>₩{(p.hours * p.wage * 4).toLocaleString()}</Text>
            </View>
          ))}
          <Divider />
          <View style={styles.payRow}>
            <Text style={styles.payTotalLabel}>합계 (예상)</Text>
            <Text style={styles.payTotal}>
              ₩{STAFF.reduce((s, p) => s + p.hours * p.wage * 4, 0).toLocaleString()}
            </Text>
          </View>
        </View>
      </Card>
    </>
  );
}

function TaxTab() {
  return (
    <>
      <Card>
        <View style={styles.rowBetween}>
          <SectionTitle>부가세 예상</SectionTitle>
          <Badge label="2분기" tone="neutral" />
        </View>
        <Text style={styles.taxAmount}>₩1,284,000</Text>
        <Text style={styles.hint}>매출 세액 − 매입 세액 기준 예상치</Text>
        <Divider />
        <View style={styles.taxLine}>
          <Text style={styles.taxLabel}>매출 세액</Text>
          <Text style={styles.taxVal}>₩3,120,000</Text>
        </View>
        <View style={styles.taxLine}>
          <Text style={styles.taxLabel}>매입 세액</Text>
          <Text style={styles.taxVal}>− ₩1,836,000</Text>
        </View>
      </Card>

      {/* 신고 초안 (draft_) */}
      <Card tone="cream">
        <View style={styles.rowBetween}>
          <SectionTitle>부가세 신고 초안</SectionTitle>
          <Badge label="확정 전" tone="orange" />
        </View>
        <Text style={styles.hint}>
          자동 생성된 신고 초안이에요. 검토 후 세무사 확인·확정하세요. (자동 신고 안 됨)
        </Text>
        <View style={styles.actions}>
          <Button
            label="초안 상세 보기"
            variant="secondary"
            style={{ flex: 1 }}
            onPress={() =>
              notify(
                '부가세 신고 초안',
                '과세표준 31,200,000원\n매출세액 3,120,000원\n매입세액 1,836,000원\n납부예상 1,284,000원\n\n검토 후 세무사에게 공유하세요.'
              )
            }
          />
          <Button
            label="세무사 공유"
            style={{ flex: 1 }}
            onPress={() => notify('공유 완료', '신고 초안을 담당 세무사에게 전달했어요. 확정은 세무사 확인 후 진행됩니다.')}
          />
        </View>
      </Card>

      <Card>
        <SectionTitle>다가오는 신고 일정</SectionTitle>
        <View style={{ marginTop: 10, gap: 10 }}>
          <View style={styles.dueRow}>
            <Ionicons name="calendar-outline" size={18} color={colors.pointOrange} />
            <Text style={styles.dueText}>부가세 확정신고</Text>
            <Badge label="D-12" tone="danger" />
          </View>
          <View style={styles.dueRow}>
            <Ionicons name="calendar-outline" size={18} color={colors.mochaBrown} />
            <Text style={styles.dueText}>원천세 납부</Text>
            <Badge label="D-25" tone="neutral" />
          </View>
        </View>
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hint: { ...typography.L5, color: colors.mochaBrown, marginTop: 6, lineHeight: 15 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  shiftRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dayChip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.coffeeCream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: { ...typography.L4, color: colors.espressoBrown },
  shiftWho: { ...typography.L4, color: colors.espressoBrown },
  shiftSlot: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  payRow: { flexDirection: 'row', alignItems: 'center' },
  payName: { ...typography.L4, color: colors.espressoBrown },
  paySub: { ...typography.L5, color: colors.mochaBrown, marginTop: 2 },
  payAmount: { ...typography.L3, color: colors.espressoBrown },
  payTotalLabel: { ...typography.L4, color: colors.mochaBrown, flex: 1 },
  payTotal: { ...typography.L3, color: colors.pointOrange },
  taxAmount: { ...typography.L2, color: colors.espressoBrown, marginTop: 8, marginBottom: 2 },
  taxLine: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  taxLabel: { ...typography.L4, color: colors.mochaBrown },
  taxVal: { ...typography.L4, color: colors.espressoBrown },
  dueRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dueText: { ...typography.L4, color: colors.espressoBrown, flex: 1 },
});
