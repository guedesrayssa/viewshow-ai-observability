import { test } from "node:test";
import assert from "node:assert/strict";
import { AnalysisWorker, validateWindow } from "../src/worker/orchestrator.js";
import type { AnalysisQueue, AnalysisScope, AnalysisStore, Delivery, Lease, Observation, ScopeCheckpoint } from "../src/worker/types.js";
import type { WindowedEvent } from "../src/contracts/analysis-event.js";
import type { ModelBundle } from "../src/worker/models.js";

const scope: AnalysisScope = { id:"canal-a", source:"argus", entity:"Canal A", priority:"P2", detectorMetrics:["bufferratio_avg"], series:[
  {metric:"bufferratio_avg",seriesId:"buffer",unit:"ratio",grainSeconds:3600}, {metric:"sessions",seriesId:"sessions",unit:"count",grainSeconds:3600},
  {metric:"errors",seriesId:"errors",unit:"count",grainSeconds:3600}, {metric:"startup_errors",seriesId:"startup",unit:"count",grainSeconds:3600},
] };
const model: ModelBundle = { schemaVersion:"analysis-models-v1",name:"qoe-random-forest",version:"1",approved:true,trainedThrough:"2025-12-01T00:00:00Z",datasetVersion:"d1",
  approval:{reference:"test",sourceSha256:"a".repeat(64),approvedAt:"2025-12-02T00:00:00Z"},
  features:["bufferratio_avg","lag_1h","lag_2h","lag_3h","roll_mean_3h","sessions","errors","startup_errors","hora_sin","hora_cos","dia_semana"],
  forecast:{trees:[{left:[-1],right:[-1],feature:[-2],threshold:[-2],value:[0.8]}],calibration:{x:[0,1],y:[0,1]},valueThreshold:.5,riskThreshold:.4,highRiskThreshold:.7},
  detection:{robustThreshold:3.5,minHistoryDays:3,minHistoryPoints:96,scopes:{}} };
const event: WindowedEvent = { eventId:"e",eventType:"QOE_FORECAST",schemaVersion:"1.0",idempotencyKey:"k",traceId:"t",occurredAt:"2026-01-01T04:00:00Z",producedAt:"2026-01-01T04:01:00Z",source:"ingestion",
  payload:{window:{start:"2026-01-01T03:00:00Z",end:"2026-01-01T04:00:00Z",grainSeconds:3600},inputWatermark:"2026-01-01T04:00:00Z",datasetVersion:"d1",
    scope:{kind:"channel",dimensions:{scopeId:"canal-a"}},model:{name:"qoe-random-forest",version:"1"},targetWindow:{start:"2026-01-01T04:00:00Z",end:"2026-01-01T05:00:00Z"}} };
const rows: Observation[] = [];
for (let h=0;h<4;h++) for (const [metric,value,unit] of [["bufferratio_avg",.1+h/100,"ratio"],["sessions",100,"count"],["errors",2,"count"],["startup_errors",1,"count"]] as const)
  rows.push({id:`${metric}-${h}`,datasetVersion:"d1",scopeId:"canal-a",metric,unit,timestamp:`2026-01-01T0${h}:00:00Z`,grainSeconds:3600,value});

class MemoryStore implements AnalysisStore {
  state=""; checkpointValue: ScopeCheckpoint|null=null; results=0; diagnoses=0; validations=0;
  async acquire(){return "acquired" as const} async renew(){} async finish(_l:Lease,state:string){this.state=state}
  async checkpoint(){return this.checkpointValue} async saveCheckpoint(_l:Lease,_s:string,v:ScopeCheckpoint){this.checkpointValue=structuredClone(v)}
  async resolveIncident():Promise<never>{throw new Error("unused")} async correlate():Promise<string>{throw new Error("forecast cannot create incident")}
  async saveResult(){this.results++} async saveDiagnosis(){this.diagnoses++} async validatePredictions(){this.validations++}
}
class MemoryQueue implements AnalysisQueue { ack=0; dlq=0; visibilityCalls:number[]=[]; async receive(){return []} async acknowledge(){this.ack++} async visibility(_r:string,s:number){this.visibilityCalls.push(s)} async deadLetter(){this.dlq++} }

test("previsão elevada é persistida e diagnosticada sem criar incidente", async()=>{
  const store=new MemoryStore(), queue=new MemoryQueue(); let llmCalls=0;
  const llm={generate:async (request:{userPrompt:string})=>{ llmCalls++; const context=JSON.parse(request.userPrompt).context; const fact=context.facts.find((f:{metric:string})=>f.metric==="bufferratio_avg");
    return{text:JSON.stringify({hypotheses:[{category:"delivery_instability",supporting:[{factId:fact.id,metric:fact.metric,scopeId:fact.scopeId,direction:fact.direction}],contradicting:[]}],nextChecks:["network"]}),provider:"fake",modelId:"test",stopReason:"stop" as const}; }};
  const worker=new AnalysisWorker({store,queue,reader:{read:async()=>rows},model,scopes:[scope],now:()=>Date.parse("2026-01-01T04:02:00Z"),
    llm});
  const delivery:Delivery={id:"m",receipt:"r",body:JSON.stringify(event),receives:1}; await worker.process(delivery);
  assert.equal(store.state,"SUCCEEDED"); assert.equal(queue.ack,1); assert.equal(queue.dlq,0); assert.equal(store.results,1); assert.equal(store.diagnoses,1); assert.equal(store.validations,1); assert.equal(llmCalls,1);
  assert.equal(store.checkpointValue?.incidentId,null); assert.ok(store.checkpointValue?.predictionId); assert.equal(store.checkpointValue?.diagnosis?.status,"ready");
  assert.equal(store.checkpointValue?.result.signals.find(signal=>signal.detector==="qoe-forecast")?.experimental,true);
});

test("evento inválido vai direto à DLQ sem modelo nem LLM", async()=>{
  const store=new MemoryStore(),queue=new MemoryQueue(); const worker=new AnalysisWorker({store,queue,reader:{read:async()=>[]},model,scopes:[scope],llm:{generate:async()=>{throw new Error("unused")}}});
  await worker.process({id:"m",receipt:"r",body:"{",receives:1});
  assert.equal(queue.dlq,1); assert.equal(queue.ack,1); assert.equal(store.state,"");
});

test("janela incompleta ou watermark atrasado é rejeitada",()=>{
  assert.throws(()=>validateWindow({...event,payload:{...event.payload,inputWatermark:"2026-01-01T03:59:59Z"}}),/INVALID_COMPLETE_WINDOW/);
});
