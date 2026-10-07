// Three independent 150k profiles, with an explicit 900s budget and owned-task cleanup.
import {spawn,spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const lab=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(lab,'../../../../..');
const output=path.resolve(process.env.RESULTS_DIR);
const expected=process.env.EXPECTED_AWS_ACCOUNT_ID;
const url=process.env.BASE_URL;
function aws(args){const r=spawnSync('aws',[...args,'--region','us-east-1','--output','json'],{encoding:'utf8'});if(r.status!==0)throw Error('AWS operation failed');return JSON.parse(r.stdout);}
if(aws(['sts','get-caller-identity']).Account!==expected)throw Error('Account mismatch');
const def=aws(['ecs','describe-task-definition','--task-definition','view-show-iac-api-task:1']).taskDefinition;
const secret=def.containerDefinitions.find(c=>c.name==='view-show-iac-api').environment.find(e=>e.name==='AUTH_COOKIE_SECRET').value;
function cookie(){const now=Math.floor(Date.now()/1000);const p=Buffer.from(JSON.stringify({id:'k6-load-test',email:'k6-load-test@globoplay.com',name:null,role:'engineer',issuedAt:now,expiresAt:now+14400,sessionId:'rnf-replicas-'+now})).toString('base64url');return p+'.'+createHmac('sha256',secret).update(p).digest('base64url');}
async function imports(){const r=await fetch(url+'/api/v1/imports',{headers:{Cookie:'session='+cookie()}});if(!r.ok)throw Error('Cannot inspect imports');const d=await r.json();return Array.isArray(d.data)?d.data:(d.data.items||d.data.imports||[]);}
function safe(job){return {importId:job.importId,state:job.state,progress:job.progress,errorCode:job.error?.code,candidateVersion:job.candidateVersion,createdAt:job.createdAt,updatedAt:job.updatedAt};}
async function ownedTask(importId){const arns=aws(['ecs','list-tasks','--cluster','view-show-iac-cluster','--family','view-show-ingestion-import']).taskArns;if(!arns.length)return null;const tasks=aws(['ecs','describe-tasks','--cluster','view-show-iac-cluster','--tasks',...arns]).tasks;return tasks.find(t=>t.overrides?.containerOverrides?.some(c=>c.environment?.some(e=>e.name==='IMPORT_ID'&&e.value===importId)))?.taskArn;}
mkdirSync(output,{recursive:true});const reports=[];
for(let repetition=1;repetition<=3;repetition++){
 const folder=path.join(output,`r${repetition}`);mkdirSync(folder,{recursive:true});
 const dump=path.join(root,`.artifacts/rnf-masses/nominal-r${repetition}/argus_dump.sql.gz`);
 const bytes=statSync(dump).size;const before=new Set((await imports()).map(j=>j.importId));
 const began=Date.now();let job=null;let sampling=false;
 const sampler=setInterval(async()=>{if(sampling)return;sampling=true;try{const jobs=await imports();job=jobs.find(j=>!before.has(j.importId)&&j.requestedBy==='k6-load-test'&&j.sizeBytes===bytes);if(job)writeFileSync(path.join(folder,'progress.json'),JSON.stringify({observedAt:new Date().toISOString(),...safe(job)},null,2)+'\n');}catch(error){console.error('Progress sampling unavailable: '+error.name);}finally{sampling=false;}},15000);
 const child=spawn(process.execPath,[path.join(lab,'run-aws-evidence.mjs')],{cwd:root,env:{...process.env,DUMP:dump,EXPECTED_EVENTS:'150000',MODE:'drenagem',POLL_TIMEOUT_S:'900',POLL_INTERVAL_S:'10',SNAPSHOT_EXTRACTED_ON:'2026-10-06',RUN_LABEL:`nominal-r${repetition}`,RESULTS_DIR:folder},stdio:['ignore','inherit','inherit']});
 const exit=await new Promise(resolve=>child.on('exit',resolve));clearInterval(sampler);
 job=(await imports()).find(j=>!before.has(j.importId)&&j.requestedBy==='k6-load-test'&&j.sizeBytes===bytes);
 if(!job)throw Error('Cannot identify the import owned by this repetition; no task is stopped');
 const report={repetition,startedAt:new Date(began).toISOString(),finishedClientAt:new Date().toISOString(),clientExitCode:exit,processingBudgetSeconds:900,scope:'independent concentrated 150k mass, same runtime; correct budget is fixed before each run',beforeCleanup:safe(job)};
 if(!['READY','FAILED'].includes(job.state)){
  const task=await ownedTask(job.importId);if(!task)throw Error('Cannot identify the owned active task');
  report.stopRequestedAt=new Date().toISOString();report.taskArn=task;
  aws(['ecs','stop-task','--cluster','view-show-iac-cluster','--task',task,'--reason',`RNF nominal-r${repetition}: owned synthetic import exceeded the predeclared900s budget`]);
  for(let attempt=0;attempt<24;attempt++){await delay(10000);job=(await imports()).find(j=>j.importId===job.importId);if(['READY','FAILED'].includes(job.state))break;}
 }
 report.terminal=safe(job);report.completedAt=new Date().toISOString();reports.push(report);
 writeFileSync(path.join(folder,'outcome.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(path.join(output,'summary.json'),JSON.stringify(reports,null,2)+'\n');
 console.log('Repetition completed: '+JSON.stringify({repetition,state:job.state,recordsWritten:job.progress?.recordsWritten}));
 // A killed worker can retain a300s lease; respect that measured recovery boundary.
 if(repetition<3&&report.stopRequestedAt){const remaining=320000-(Date.now()-Date.parse(report.stopRequestedAt));if(remaining>0)await delay(remaining);}
}
