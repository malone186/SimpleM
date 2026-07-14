import { StyleSheet, Text, View } from 'react-native';

export default function SchedulePayrollScreen() {
  return (
    <View style={styles.container}>
      <Text>스케줄 · 급여</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
