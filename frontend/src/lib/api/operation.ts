// 프론트 B 담당
import { apiFetch } from './client';

export function getOperationSchedule() {
  return apiFetch('/api/v1/operation/schedule');
}

export function getTaxSummary() {
  return apiFetch('/api/v1/operation/tax');
}
