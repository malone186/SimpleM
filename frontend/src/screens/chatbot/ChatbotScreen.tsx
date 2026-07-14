import { StyleSheet, Text, View } from 'react-native';

export default function ChatbotScreen() {
  return (
    <View style={styles.container}>
      <Text>챗봇</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
