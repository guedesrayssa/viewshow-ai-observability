import { test } from "node:test";
import assert from "node:assert/strict";
import { AnalysisWorker, validateWindow } from "../src/worker/orchestrator.js";
import { createLlmProvider } from "../src/bootstrap/llm-provider-factory.js";
import type { AnalysisQueue, AnalysisScope, AnalysisStore, Delivery, Lease, Observation, ScopeCheckpoint, Telemetry } from "../src/worker/types.js";
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
  state=""; claim:"acquired"|"busy"|"complete"="acquired"; checkpointValue: ScopeCheckpoint|null=null; results=0; diagnoses=0; validations=0; correlation:{incidentId:string;isNew:boolean}|null=null;
  async acquire(){return this.claim} async renew(){} async finish(_l:Lease,state:string){this.state=state}
  async checkpoint(){return this.checkpointValue} async saveCheckpoint(_l:Lease,_s:string,v:ScopeCheckpoint){this.checkpointValue=structuredClone(v)}
  async resolveIncident():ReturnType<AnalysisStore["resolveIncident"]>{throw new Error("unused")} async correlate():Promise<{incidentId:string;isNew:boolean}>{if(!this.correlation)throw new Error("unexpected correlation");return this.correlation}
  async saveResult(){this.results++} async saveDiagnosis(_l?:Lease,_c?:ScopeCheckpoint){this.diagnoses++} async validatePredictions(){this.validations++}
}
class MemoryQueue implements AnalysisQueue { ack=0; dlq=0; visibilityCalls:number[]=[]; async receive(){return []} async acknowledge(){this.ack++} async visibility(_r:string,s:number){this.visibilityCalls.push(s)} async deadLetter(){this.dlq++} }
type LoggedEvent={name:string;fields:Record<string,string|number|boolean|null>};
function captureTelemetry(events:LoggedEvent[]):Telemetry{return(name,fields)=>events.push({name,fields})}

test("previsão elevada é persistida e diagnosticada sem criar incidente", async()=>{
  const store=new MemoryStore(), queue=new MemoryQueue(), events:LoggedEvent[]=[]; let llmCalls=0;
  const llm={generate:async (request:{userPrompt:string})=>{ llmCalls++; const context=JSON.parse(request.userPrompt).context; const fact=context.facts.find((f:{metric:string})=>f.metric==="bufferratio_avg");
    return{text:JSON.stringify({hypotheses:[{category:"delivery_instability",supporting:[{factId:fact.id,metric:fact.metric,scopeId:fact.scopeId,direction:fact.direction}],contradicting:[]}],nextChecks:["network"]}),provider:"fake",modelId:"test",stopReason:"stop" as const}; }};
  const worker=new AnalysisWorker({store,queue,reader:{read:async()=>rows},model,scopes:[scope],now:()=>Date.parse("2026-01-01T04:02:00Z"),
    llm,telemetry:captureTelemetry(events)});
  const delivery:Delivery={id:"m",receipt:"r",body:JSON.stringify(event),receives:1}; await worker.process(delivery);
  assert.equal(store.state,"SUCCEEDED"); assert.equal(queue.ack,1); assert.equal(queue.dlq,0); assert.equal(store.results,1); assert.equal(store.diagnoses,1); assert.equal(store.validations,1); assert.equal(llmCalls,1);
  assert.equal(store.checkpointValue?.incidentId,null); assert.ok(store.checkpointValue?.predictionId); assert.equal(store.checkpointValue?.diagnosis?.status,"ready");
  assert.equal(store.checkpointValue?.result.signals.find(signal=>signal.detector==="qoe-forecast")?.experimental,true);
  assert.deepEqual(events.map(item=>item.name),["analysis_started","analysis_completed"]);
  assert.equal(events[0]?.fields.eventType,"QOE_FORECAST");assert.equal(events[1]?.fields.eventType,"QOE_FORECAST");
});

test("sem LLM o diagnóstico vira falha permanente e a análise conclui sem DLQ", async()=>{
  const store=new MemoryStore(), queue=new MemoryQueue();
  const worker=new AnalysisWorker({store,queue,reader:{read:async()=>rows},model,scopes:[scope],now:()=>Date.parse("2026-01-01T04:02:00Z"),
    llm:createLlmProvider({kind:"none",modelId:"none",environment:"production"})});
  await worker.process({id:"m",receipt:"r",body:JSON.stringify(event),receives:1});
  assert.equal(store.state,"SUCCEEDED"); assert.equal(queue.ack,1); assert.equal(queue.dlq,0); assert.deepEqual(queue.visibilityCalls,[]);
  assert.equal(store.results,1); assert.equal(store.diagnoses,1);
  assert.equal(store.checkpointValue?.diagnosis,undefined); assert.equal(store.checkpointValue?.diagnosticFailure,"LLM_DISABLED");
});

test("evento inválido vai direto à DLQ sem modelo nem LLM", async()=>{
  const store=new MemoryStore(),queue=new MemoryQueue(),events:LoggedEvent[]=[]; const worker=new AnalysisWorker({store,queue,reader:{read:async()=>[]},model,scopes:[scope],llm:{generate:async()=>{throw new Error("unused")}},telemetry:captureTelemetry(events)});
  await worker.process({id:"m",receipt:"r",body:"{",receives:1});
  assert.equal(queue.dlq,1); assert.equal(queue.ack,1); assert.equal(store.state,"");
  assert.deepEqual(events.map(item=>item.name),["analysis_failed"]);assert.equal(events[0]?.fields.eventType,"unknown");
});

test("mensagem já concluída emite sucesso lógico antes do ack",async()=>{
  const store=new MemoryStore(),queue=new MemoryQueue(),events:LoggedEvent[]=[];store.claim="complete";
  const worker=new AnalysisWorker({store,queue,reader:{read:async()=>[]},model,scopes:[scope],llm:{generate:async()=>{throw new Error("unused")}},telemetry:captureTelemetry(events)});
  await worker.process({id:"duplicate",receipt:"r",body:JSON.stringify(event),receives:2});
  assert.equal(queue.ack,1);assert.deepEqual(queue.visibilityCalls,[]);
  assert.deepEqual(events.map(item=>item.name),["analysis_started","analysis_completed"]);
  assert.equal(events[1]?.fields.reason,"duplicate");assert.equal(events[1]?.fields.eventType,"QOE_FORECAST");
});

test("lease ocupado emite retry lógico antes de adiar a mensagem",async()=>{
  const store=new MemoryStore(),queue=new MemoryQueue(),events:LoggedEvent[]=[];store.claim="busy";
  const worker=new AnalysisWorker({store,queue,reader:{read:async()=>[]},model,scopes:[scope],llm:{generate:async()=>{throw new Error("unused")}},telemetry:captureTelemetry(events)});
  await worker.process({id:"busy",receipt:"r",body:JSON.stringify(event),receives:1});
  assert.equal(queue.ack,0);assert.deepEqual(queue.visibilityCalls,[60]);
  assert.deepEqual(events.map(item=>item.name),["analysis_started","analysis_deferred"]);
  assert.equal(events[1]?.fields.reason,"lease_busy");assert.equal(events[1]?.fields.eventType,"QOE_FORECAST");
});

test("janela incompleta ou watermark atrasado é rejeitada",()=>{
  assert.throws(()=>validateWindow({...event,payload:{...event.payload,inputWatermark:"2026-01-01T03:59:59Z"}}),/INVALID_COMPLETE_WINDOW/);
});

test("bucket de episódio existente persiste análise sem chamar a LLM novamente",async()=>{
  const detectorScope:AnalysisScope={id:"canal-a",source:"argus",entity:"Canal A",priority:"P2",detectorMetrics:["buffer"],episodeWindowSeconds:7200,series:[{metric:"buffer",seriesId:"buffer-15m",unit:"ratio",grainSeconds:900}]};
  const detectorModel:ModelBundle={...model,detection:{robustThreshold:3.5,minHistoryDays:3,minHistoryPoints:96,scopes:{}}};
  const detectorRows:Observation[]=[];
  for(let point=0;point<7*96;point++) detectorRows.push({id:`h-${point}`,datasetVersion:"d1",scopeId:"canal-a",metric:"buffer",unit:"ratio",timestamp:new Date(Date.parse("2025-12-25T00:00:00Z")+point*900000).toISOString(),grainSeconds:900,value:point%2?1:1.2});
  detectorRows.push({id:"current",datasetVersion:"d1",scopeId:"canal-a",metric:"buffer",unit:"ratio",timestamp:"2026-01-01T00:00:00Z",grainSeconds:900,value:4});
  const detectorEvent:WindowedEvent={...event,eventType:"ANOMALY_DETECTION",payload:{window:{start:"2026-01-01T00:00:00Z",end:"2026-01-01T00:15:00Z",grainSeconds:900},inputWatermark:"2026-01-01T00:15:00Z",datasetVersion:"d1",scope:{kind:"channel",dimensions:{scopeId:"canal-a"}}}};
  const store=new MemoryStore(),queue=new MemoryQueue();store.correlation={incidentId:"inc-existing",isNew:false};let llmCalls=0;
  const worker=new AnalysisWorker({store,queue,reader:{read:async()=>detectorRows},model:detectorModel,scopes:[detectorScope],llm:{generate:async()=>{llmCalls++;throw new Error("must not run")}},now:()=>Date.parse("2026-01-01T00:16:00Z")});
  await worker.process({id:"m",receipt:"r",body:JSON.stringify(detectorEvent),receives:1});
  assert.equal(store.state,"SUCCEEDED");assert.equal(store.checkpointValue?.incidentId,"inc-existing");assert.equal(store.checkpointValue?.episodeStarted,false);
  assert.equal(store.results,1);assert.equal(store.diagnoses,0);assert.equal(llmCalls,0);
});

test("falha transitória libera a mensagem com backoff e marca nova tentativa",async()=>{
  const store=new MemoryStore(),queue=new MemoryQueue(),events:LoggedEvent[]=[];
  const worker=new AnalysisWorker({store,queue,reader:{read:async()=>{throw new Error("dynamodb unavailable")}},model,scopes:[scope],llm:{generate:async()=>{throw new Error("unused")}},telemetry:captureTelemetry(events)});
  await worker.process({id:"m",receipt:"r",body:JSON.stringify(event),receives:2});
  assert.equal(store.state,"RETRY_PENDING");assert.deepEqual(queue.visibilityCalls,[120]);assert.equal(queue.ack,0);assert.equal(queue.dlq,0);
  assert.deepEqual(events.map(item=>item.name),["analysis_started","analysis_failed"]);assert.equal(events[1]?.fields.eventType,"QOE_FORECAST");assert.equal(events[1]?.fields.status,"retry");assert.equal(events[1]?.fields.terminal,false);assert.equal("message" in events[1]!.fields,false);
});

test("quinta falha de dependência encerra a execução e envia à DLQ",async()=>{
  const store=new MemoryStore(),queue=new MemoryQueue(),events:LoggedEvent[]=[];
  const worker=new AnalysisWorker({store,queue,reader:{read:async()=>{throw new Error("dynamodb unavailable")}},model,scopes:[scope],llm:{generate:async()=>{throw new Error("unused")}},telemetry:captureTelemetry(events)});
  await worker.process({id:"m",receipt:"r",body:JSON.stringify(event),receives:5});
  assert.equal(store.state,"FAILED");assert.equal(queue.dlq,1);assert.equal(queue.ack,1);assert.deepEqual(queue.visibilityCalls,[]);
  assert.deepEqual(events.map(item=>item.name),["analysis_started","analysis_failed"]);assert.equal(events[1]?.fields.eventType,"QOE_FORECAST");assert.equal(events[1]?.fields.status,"failure");assert.equal(events[1]?.fields.terminal,true);
});

test("reanálise sem histórico suficiente publica falha explícita com a projeção de apresentação",async()=>{
  const incidentScope:AnalysisScope={id:"canal-q",source:"argus",entity:"Canal Q",priority:"P2",detectorMetrics:["bufferratio_avg"],series:[
    {metric:"bufferratio_avg",seriesId:"buffer-q",unit:"ratio",grainSeconds:900},{metric:"affected_devices",seriesId:"devices-q",unit:"devices",grainSeconds:900}]};
  const windowed:WindowedEvent={eventId:"evt_reanalysis",eventType:"ANOMALY_DETECTION",schemaVersion:"1.0",idempotencyKey:"incident:inc_q",traceId:"inc_q",occurredAt:"2026-01-01T03:15:00Z",producedAt:"2026-01-01T03:15:00Z",source:"incident-projection",
    payload:{window:{start:"2026-01-01T03:00:00Z",end:"2026-01-01T03:15:00Z",grainSeconds:900},inputWatermark:"2026-01-01T03:15:00Z",datasetVersion:"d1",scope:{kind:"incident",dimensions:{scopeId:"canal-q"}}}};
  class ReanalysisStore extends MemoryStore{saved:ScopeCheckpoint[]=[];
    override async resolveIncident(){return{event:windowed,scope:incidentScope,incidentId:"inc_q",resolution:"projection" as const}}
    override async saveDiagnosis(_l?:Lease,checkpoint?:ScopeCheckpoint){this.diagnoses++;if(checkpoint)this.saved.push(structuredClone(checkpoint))}}
  const store=new ReanalysisStore(),queue=new MemoryQueue(),events:LoggedEvent[]=[];let llmCalls=0;
  const current:Observation[]=([["bufferratio_avg",.4,"ratio"],["affected_devices",7,"devices"]] as const).map(([metric,value,unit])=>
    ({id:`${metric}-q`,datasetVersion:"d1",scopeId:"canal-q",metric,unit,timestamp:"2026-01-01T03:00:00.000Z",grainSeconds:900,value}));
  const worker=new AnalysisWorker({store,queue,reader:{read:async()=>current},model,scopes:[incidentScope],llm:{generate:async()=>{llmCalls++;throw new Error("must not run")}},
    telemetry:captureTelemetry(events),now:()=>Date.parse("2026-01-01T03:20:00Z")});
  const request={eventId:"evt_req",eventType:"REANALYSIS_REQUESTED",schemaVersion:"1.0",idempotencyKey:"req-1",traceId:"trc_req",occurredAt:"2026-01-01T03:19:00Z",producedAt:"2026-01-01T03:19:00Z",source:"api",
    payload:{incidentId:"inc_q",requestedBy:"usr_1",reason:"MANUAL_REQUEST"}};
  await worker.process({id:"m",receipt:"r",body:JSON.stringify(request),receives:1});
  assert.equal(store.state,"SUCCEEDED");assert.equal(queue.dlq,0);assert.equal(queue.ack,1);assert.equal(llmCalls,0);
  assert.equal(store.diagnoses,1);assert.equal(store.saved[0]?.incidentId,"inc_q");assert.equal(store.saved[0]?.context,null);
  assert.equal(store.saved[0]?.diagnosticFailure,"INSUFFICIENT_HISTORY");assert.equal(store.saved[0]?.presentation?.impact.affectedDevices?.value,7);
  assert.deepEqual(events.map(item=>item.name),["analysis_started","analysis_incident_resolved","analysis_diagnosis_unavailable","analysis_completed"]);
  assert.equal(events[1]?.fields.resolution,"projection");assert.equal(events[2]?.fields.reason,"INSUFFICIENT_HISTORY");assert.equal(events[3]?.fields.diagnoses,1);
});
