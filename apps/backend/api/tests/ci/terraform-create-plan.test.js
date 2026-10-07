const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
test('plan gate rejects data loss during ECS migration', async () => {
  const { validatePlan } = await import(pathToFileURL(path.resolve(__dirname,'../../../../scripts/terraform/validate-create-plan.mjs')));
  const cluster = {mode:'managed',type:'aws_eks_cluster',address:'aws_eks_cluster.principal',change:{actions:['create']}};
  assert.throws(() => validatePlan({resource_changes:[cluster,{mode:'managed',type:'aws_dynamodb_table',address:'aws_dynamodb_table.operacional',change:{actions:['delete','create']}}]},{migration:true}));
});
