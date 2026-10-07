// Exercise the deployed policy as the real API service account, without creating Jobs.
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const namespace='view-show-rnf-imports';
const actor='system:serviceaccount:view-show-rnf:api';
function kubectl(args,input){return spawnSync('kubectl',args,{input,encoding:'utf8',maxBuffer:8*1024*1024});}
const context=kubectl(['config','view','--minify','-o','jsonpath={.contexts[0].context.cluster}']);
if(context.stdout.trim()!=='arn:aws:eks:us-east-1:239162056821:cluster/view-show-rnf-eks')throw Error('Owned EKS context required');
const response=kubectl(['-n',namespace,'get','cronjob','ingestion-import','-o','json']);if(response.status!==0)throw Error('Cannot read template');
const template=JSON.parse(response.stdout);
const importId='imp_01M4A2AAAAAAAAAAAAAAAAAAAA';
const job={apiVersion:'batch/v1',kind:'Job',metadata:{name:'import-'+importId.slice(4).toLowerCase(),namespace,labels:{'app.kubernetes.io/name':'ingestion-import','view-show/import-id':importId,'view-show/pipeline':'legacy-v1'}},spec:structuredClone(template.spec.jobTemplate.spec)};
const worker=job.spec.template.spec.containers[0];
worker.args=['import-dump','--import-id',importId];
worker.env=worker.env.filter(v=>!['IMPORT_ID','IMPORT_PIPELINE_VERSION'].includes(v.name));
worker.env.push({name:'IMPORT_ID',value:importId},{name:'IMPORT_PIPELINE_VERSION',value:'legacy-v1'});
const cases=[['valid template',null,true],['different worker image',j=>{j.spec.template.spec.containers[0].image='busybox:1.37';},false],['arbitrary worker command',j=>{j.spec.template.spec.containers[0].command=['sh','-c','true'];},false],['injected environment',j=>{j.spec.template.spec.containers[0].env.push({name:'INJECTED',value:'1'});},false],['hostPath volume',j=>{j.spec.template.spec.volumes[0]={name:'tmp',hostPath:{path:'/'}};},false],['privileged worker',j=>{j.spec.template.spec.containers[0].securityContext.privileged=true;j.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation=true;},false],['different service account',j=>{j.spec.template.spec.serviceAccountName='api';},false],['different MySQL probe',j=>{j.spec.template.spec.initContainers[0].startupProbe.exec.command=['true'];},false]];
const checks=[];
for(const [name,mutate,expectedAllowed]of cases){const input=structuredClone(job);mutate?.(input);const result=kubectl(['--as',actor,'-n',namespace,'create','--dry-run=server','-f','-','-o','name'],JSON.stringify(input));const allowed=result.status===0;const deniedByPolicy=!allowed&&/admission policy|admissionpolicy|denied request/i.test(result.stderr);checks.push({name,expectedAllowed,allowed,deniedByPolicy,passed:expectedAllowed?allowed:deniedByPolicy,...(allowed?{}:{error:result.stderr.slice(0,1000)})});}
const report={observedAt:new Date().toISOString(),context:context.stdout.trim(),actor,scope:'server dry-run; no Job, Pod, S3 object or data write',checks,passed:checks.every(c=>c.passed)};
writeFileSync(process.env.OUTPUT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
