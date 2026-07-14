import { StyleSheet, Text, View } from 'react-native';

export default function TaxScreen() {
  return (
    <View style={styles.container}>
      <Text>세금</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
