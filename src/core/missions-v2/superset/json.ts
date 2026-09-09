#!/usr/bin/env typescript
/** Superset CLI JSON helpers — fail closed on unknown shapes. */
import { z } from 'zod';

export class SupersetParseError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'SupersetParseError';
  }
}

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new SupersetParseError('empty_output');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new SupersetParseError('non_json_output');
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new SupersetParseError('malformed_json');
    }
  }
}

export function parseStrict<S extends z.ZodTypeAny>(schema: S, raw: string): z.output<S> {
  const value = extractJsonObject(raw);
  const unwrapped =
    value && typeof value === 'object' && value !== null && 'data' in value
      && (value as { data: unknown }).data
      && typeof (value as { data: unknown }).data === 'object'
      ? (value as { data: unknown }).data
      : value;
  const parsed = schema.safeParse(unwrapped);
  if (!parsed.success) throw new SupersetParseError('schema_mismatch', parsed.error.message);
  return parsed.data as z.output<S>;
}

export const uuidSchema = z.string().uuid();
export const sha40Schema = z.string().regex(/^[0-9a-f]{40}$/);

export const terminalCreateSchema = z.object({
  terminalId: uuidSchema,
}).passthrough();

export const terminalReadSchema = z.object({
  text: z.string(),
}).passthrough();

export const terminalCloseSchema = z.object({
  status: z.string().optional(),
  terminalId: uuidSchema.optional(),
}).passthrough();

export const projectCreateSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(200).optional(),
}).passthrough();

export const workspaceCreateSchema = z.object({
  id: uuidSchema,
  worktreePath: z.string().min(1).max(500).optional(),
  path: z.string().min(1).max(500).optional(),
  branch: z.string().min(1).max(200).optional(),
}).passthrough().transform((w) => ({
  id: w.id,
  worktreePath: w.worktreePath ?? w.path ?? '',
  branch: w.branch ?? '',
}));

export const workspaceGetSchema = z.object({
  id: uuidSchema,
  worktreePath: z.string().min(1).max(500).optional(),
  path: z.string().min(1).max(500).optional(),
  branch: z.string().min(1).max(200).optional(),
  name: z.string().optional(),
}).passthrough().transform((w) => ({
  id: w.id,
  worktreePath: w.worktreePath ?? w.path ?? '',
  branch: w.branch ?? '',
  name: w.name,
}));

export const statusSchema = z.object({
  running: z.boolean(),
  healthy: z.boolean().optional(),
  cloudRegistered: z.boolean().optional(),
}).passthrough();
