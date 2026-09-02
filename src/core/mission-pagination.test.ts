import { describe, it, expect } from 'vitest';
import { parseMissionPagination } from './mission-pagination.js';

describe('parseMissionPagination', () => {
  it('borne limit et offset', () => {
    expect(parseMissionPagination('200', '50000')).toEqual({ limit: 100, offset: 10000 });
    expect(parseMissionPagination('-1', '-5')).toEqual({ limit: 1, offset: 0 });
  });

  it('utilise les défauts sur entrées invalides', () => {
    expect(parseMissionPagination('abc', 'xyz')).toEqual({ limit: 50, offset: 0 });
  });
});
