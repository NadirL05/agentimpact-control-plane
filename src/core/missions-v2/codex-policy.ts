import {z} from 'zod';

const safeId=z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const relativePath=z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,300}$/);

/** The worker and control daemon must interpret one strict repository policy. */
export const codexRepositoryPolicySchema=z.object({
  repoId:safeId,
  mirrorPath:z.string().startsWith('/').max(400),
  allowedPaths:z.array(relativePath).min(1).max(100),
  maxDiffBytes:z.number().int().positive().max(10*1024*1024),
  requiredTests:z.array(z.object({
    name:safeId,file:z.string().startsWith('/').max(400),args:z.array(z.string().max(500)).max(50),
  }).strict()).min(1).max(30),
}).strict();

export const codexRepositoryRegistrySchema=z.object({
  repositories:z.array(codexRepositoryPolicySchema).min(1).max(20),
}).strict();

export type CodexRepositoryPolicy=z.infer<typeof codexRepositoryPolicySchema>;
export type CodexRepositoryRegistry=z.infer<typeof codexRepositoryRegistrySchema>;
