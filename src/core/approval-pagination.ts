/**
 * Pagination bornée pour GET /api/approvals/pending.
 */

export type ApprovalPagination = {
  limit: number;
};

export function parseApprovalPagination(limitRaw: string | undefined): ApprovalPagination {
  const requestedLimit = Number(limitRaw ?? 50);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 50;

  return { limit };
}
