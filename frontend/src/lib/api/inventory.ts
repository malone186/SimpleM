// 프론트 A 담당
import { apiFetch } from './client';

export function getInventory() {
  return apiFetch('/api/v1/inventory');
}
