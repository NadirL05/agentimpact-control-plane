import {expect,it} from 'vitest';
import {codexRepositoryRegistrySchema} from './codex-policy.js';

const compatible={
  repositories:[{
    repoId:'codex-r8-3d034b98-a775-41db-bffc-bd0e7dc24d0c',
    mirrorPath:'/var/lib/agentimpact-codex-worker/fixtures/99df976d-6595-4cde-b5ba-c1c9c92fe560.git',
    allowedPaths:['src/increment.js'],
    maxDiffBytes:2048,
    requiredTests:[{name:'increment-test',file:'/usr/bin/node',args:['--test','test/increment.test.js']}],
  }],
};

it('accepts the R8 canary builder CodexPolicy shape and rejects base_sha/publisher',()=>{
  expect(codexRepositoryRegistrySchema.parse(compatible)).toEqual(compatible);
  const keys=Object.keys(compatible.repositories[0]).sort();
  expect(keys).toEqual(['allowedPaths','maxDiffBytes','mirrorPath','repoId','requiredTests']);
  expect(codexRepositoryRegistrySchema.safeParse({
    repositories:[{...compatible.repositories[0],base_sha:'31b97eeae466646dda48b85ab3e9e00e572f43d6'}],
  }).success).toBe(false);
  expect(codexRepositoryRegistrySchema.safeParse({
    repositories:[{...compatible.repositories[0],publisher:false}],
  }).success).toBe(false);
});
