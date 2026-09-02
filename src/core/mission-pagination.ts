/**
 * Pagination bornée pour GET /missions.
 */

export type MissionPagination = {
  limit: number;
  offset: number;
};

export function parseMissionPagination(
  limitRaw: string | undefined,
  offsetRaw: string | undefined,
): MissionPagination {
  const requestedLimit = Number(limitRaw ?? 50);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 50;

  const requestedOffset = Number(offsetRaw ?? 0);
  const offset = Number.isInteger(requestedOffset)
    ? Math.min(Math.max(requestedOffset, 0), 10000)
    : 0;

  return { limit, offset };
}
