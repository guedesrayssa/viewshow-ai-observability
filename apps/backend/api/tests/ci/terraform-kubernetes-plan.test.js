const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
test('plan gate rejects data loss during ECS migration', async () => {
  const { validatePlan } = await import(pathToFileURL(path.resolve(__dirname,'../../../../scripts/terraform/validate-kubernetes-plan.mjs')));
  const cluster = {mode:'managed',type:'aws_eks_cluster',address:'aws_eks_cluster.principal',change:{actions:['create']}};
  assert.throws(() => validatePlan({resource_changes:[cluster,{mode:'managed',type:'aws_dynamodb_table',address:'aws_dynamodb_table.operacional',change:{actions:['delete','create']}}]},{migration:true}));
});

const loadValidator = async () => import(pathToFileURL(path.resolve(
  __dirname, '../../../../scripts/terraform/validate-kubernetes-plan.mjs',
)));
const clusterChange = (overrides = {}) => ({
  mode: 'managed', type: 'aws_eks_cluster', address: 'aws_eks_cluster.principal',
  change: { actions: ['create'] }, ...overrides,
});

test('rejects the cluster address paired with another resource type', async () => {
  const { validatePlan } = await loadValidator();
  assert.throws(() => validatePlan({ resource_changes: [clusterChange({ type: 'aws_dynamodb_table' })] }));
});

test('rejects a data resource posing as the managed cluster', async () => {
  const { validatePlan } = await loadValidator();
  for (const address of ['aws_eks_cluster.principal', 'data.aws_eks_cluster.principal']) {
    assert.throws(() => validatePlan({ resource_changes: [clusterChange({
      mode: 'data', address, change: { actions: ['no-op'] },
    })] }));
  }
});

test('rejects duplicate cluster entries', async () => {
  const { validatePlan } = await loadValidator();
  assert.throws(() => validatePlan({ resource_changes: [clusterChange(), clusterChange()] }));
});

test('rejects DynamoDB replacement spoofing a rebuild wrapper address', async () => {
  const { validatePlan } = await loadValidator();
  for (const actions of [['create', 'delete'], ['delete', 'create']]) {
    assert.throws(() => validatePlan({ resource_changes: [clusterChange(), {
      mode: 'managed', type: 'aws_dynamodb_table', address: 'terraform_data.imagem',
      change: { actions },
    }] }, { update: true, migration: true }));
  }
});

test('rejects DynamoDB deletion spoofing a migration retirement address', async () => {
  const { validatePlan } = await loadValidator();
  assert.throws(() => validatePlan({ resource_changes: [clusterChange(), {
    mode: 'managed', type: 'aws_dynamodb_table', address: 'aws_security_group.ingestion',
    change: { actions: ['delete'] },
  }] }, { migration: true }));
});

test('rejects noncanonical and unknown action arrays before policy exceptions', async () => {
  const { validatePlan } = await loadValidator();
  for (const actions of [
    ['create', 'no-op'], ['no-op', 'no-op'], ['create', 'create'],
    ['update', 'no-op'], ['create', 'delete', 'no-op'], ['delete', 'delete'],
    ['unknown'], [],
  ]) {
    assert.throws(() => validatePlan({ resource_changes: [clusterChange({ change: { actions } })] }, {
      update: true, migration: true,
    }), undefined, JSON.stringify(actions));
  }
  for (const actions of [['read', 'no-op'], ['read', 'read']]) {
    assert.throws(() => validatePlan({ resource_changes: [clusterChange(), {
      mode: 'data', type: 'aws_caller_identity', address: 'data.aws_caller_identity.current',
      change: { actions },
    }] }), undefined, JSON.stringify(actions));
  }
});

test('rejects missing or unsupported modes and invalid identity strings', async () => {
  const { validatePlan } = await loadValidator();
  for (const mode of [undefined, null, '', 'resource']) {
    assert.throws(() => validatePlan({ resource_changes: [clusterChange({ mode })] }));
  }
  for (const identity of [
    { type: '', address: 'data..current' },
    { type: 'aws_caller_identity', address: '' },
    { type: null, address: 'data.null.current' },
    { type: 'aws_caller_identity', address: null },
    { type: 'aws_caller_identity', address: 'aws_caller_identity.current' },
  ]) {
    assert.throws(() => validatePlan({ resource_changes: [clusterChange(), {
      mode: 'data', ...identity, change: { actions: ['read'] },
    }] }));
  }
});

test('rejects duplicate addresses outside the cluster', async () => {
  const { validatePlan } = await loadValidator();
  const table = {
    mode: 'managed', type: 'aws_dynamodb_table', address: 'aws_dynamodb_table.operacional',
    change: { actions: ['no-op'] },
  };
  assert.throws(() => validatePlan({ resource_changes: [clusterChange(), table, table] }));
});

test('preserves canonical cluster creation/no-op and indexed resource identities', async () => {
  const { validatePlan } = await loadValidator();
  for (const action of ['create', 'no-op']) {
    assert.doesNotThrow(() => validatePlan({ resource_changes: [
      clusterChange({ change: { actions: [action] } }),
      { mode: 'managed', type: 'aws_dynamodb_table', address: 'aws_dynamodb_table.operacional[0]', change: { actions: ['no-op'] } },
      { mode: 'data', type: 'aws_caller_identity', address: 'data.aws_caller_identity.current["account"]', change: { actions: ['read'] } },
    ] }, { update: true }));
  }
});

test('update mode rejects unaudited persistent, identity, network and cluster updates', async () => {
  const { validatePlan } = await loadValidator();
  const changes = [
    ['aws_s3_bucket', 'aws_s3_bucket.ingestion'],
    ['aws_dynamodb_table', 'aws_dynamodb_table.operacional'],
    ['aws_cognito_user_pool', 'aws_cognito_user_pool.principal'],
    ['aws_iam_role_policy', 'aws_iam_role_policy.api_import[0]'],
    ['aws_security_group', 'aws_security_group.servico'],
  ];
  for (const [type, address] of changes) {
    assert.throws(() => validatePlan({ resource_changes: [clusterChange({ change: { actions: ['no-op'] } }), {
      mode: 'managed', type, address, change: { actions: ['update'] },
    }] }, { update: true }), undefined, address);
  }
  assert.throws(() => validatePlan({ resource_changes: [
    clusterChange({ change: { actions: ['update'] } }),
  ] }, { update: true }));
});

test('update mode permits audited non-persistent operational updates', async () => {
  const { validatePlan } = await loadValidator();
  for (const [type, address] of [
    ['terraform_data', 'terraform_data.painel'],
    ['aws_cloudwatch_dashboard', 'aws_cloudwatch_dashboard.ingestion'],
    ['aws_cloudwatch_log_metric_filter', 'aws_cloudwatch_log_metric_filter.import_active_upload_age'],
    ['aws_cloudwatch_metric_alarm', 'aws_cloudwatch_metric_alarm.import_worker_failures'],
  ]) {
    assert.doesNotThrow(() => validatePlan({ resource_changes: [clusterChange({ change: { actions: ['no-op'] } }), {
      mode: 'managed', type, address, change: { actions: ['update'] },
    }] }, { update: true }), address);
  }
});

test('preserves rebuild and migration exceptions with matching identities', async () => {
  const { validatePlan } = await loadValidator();
  for (const actions of [['create', 'delete'], ['delete', 'create']]) {
    assert.doesNotThrow(() => validatePlan({ resource_changes: [clusterChange(), {
      mode: 'managed', type: 'terraform_data', address: 'terraform_data.imagem', change: { actions },
    }] }, { update: true }));
  }
  assert.doesNotThrow(() => validatePlan({ resource_changes: [clusterChange(), {
    mode: 'managed', type: 'aws_security_group', address: 'aws_security_group.ingestion', change: { actions: ['delete'] },
  }] }, { migration: true }));
});

test('permits safe S3 CORS changes in fresh and update plans', async () => {
  const { validatePlan } = await loadValidator();
  for (const action of ['create', 'no-op', 'update']) {
    assert.doesNotThrow(() => validatePlan({ resource_changes: [clusterChange(), {
      mode: 'managed', type: 'aws_s3_bucket_cors_configuration',
      address: 'aws_s3_bucket_cors_configuration.ingestion[0]',
      change: { actions: [action] },
     }] }, { update: action === 'update' }));
   }
});

test('rejects S3 CORS deletion and replacement during migration', async () => {
  const { validatePlan } = await loadValidator();
  for (const actions of [['delete'], ['delete', 'create'], ['create', 'delete']]) {
    assert.throws(() => validatePlan({ resource_changes: [clusterChange(), {
      mode: 'managed', type: 'aws_s3_bucket_cors_configuration',
      address: 'aws_s3_bucket_cors_configuration.ingestion[0]', change: { actions },
    }] }, { update: true, migration: true }));
  }
});
