import { describe, it, expect } from 'vitest';
import { parseApprovalPagination } from './approval-pagination.js';

describe('parseApprovalPagination', () => {
  it('borne limit entre 1 et 100', () => {
    expect(parseApprovalPagination('200').limit).toBe(100);
    expect(parseApprovalPagination('0').limit).toBe(1);
    expect(parseApprovalPagination('25').limit).toBe(25);
    expect(parseApprovalPagination('bad').limit).toBe(50);
  });
});
