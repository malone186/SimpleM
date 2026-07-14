import { StyleSheet, Text, View } from 'react-native';

export default function OrderScreen() {
  return (
    <View style={styles.container}>
      <Text>발주</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
