// 프론트 B 담당
import { apiFetch } from './client';

export function sendChatMessage(message: string) {
  return apiFetch('/api/v1/chatbot', {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}
