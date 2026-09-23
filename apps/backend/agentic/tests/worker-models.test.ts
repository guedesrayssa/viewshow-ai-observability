import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanObservations, prepareContext } from "../src/worker/facts.js";
import { infer, validateBundle, type ModelBundle } from "../src/worker/models.js";
import { validateScopes } from "../src/worker/config.js";
import type { AnalysisScope, Observation } from "../src/worker/types.js";
import type { WindowedEvent } from "../src/contracts/analysis-event.js";

const scope:AnalysisScope={id:"s",source:"argus",entity:"canal",priority:"P2",detectorMetrics:["buffer"],series:[{metric:"buffer",seriesId:"b",unit:"ratio",grainSeconds:900}]};
const model:ModelBundle={schemaVersion:"analysis-models-v1",name:"qoe-random-forest",version:"1",approved:true,approval:{reference:"test",sourceSha256:"a".repeat(64),approvedAt:"2025-01-02T00:00:00Z"},trainedThrough:"2025-01-01T00:00:00Z",datasetVersion:"d",features:["bufferratio_avg","lag_1h","lag_2h","lag_3h","roll_mean_3h","sessions","errors","startup_errors","hora_sin","hora_cos","dia_semana"],forecast:{trees:[{left:[-1],right:[-1],feature:[-2],threshold:[-2],value:[.1]}],calibration:{x:[0,1],y:[0,1]},valueThreshold:.5,riskThreshold:.5,highRiskThreshold:.8},detection:{robustThreshold:3.5,minHistoryDays:3,minHistoryPoints:96,scopes:{s:{metrics:["buffer","sessions"],mean:[0,0],precision:[[1,0],[0,1]],threshold:4}}}};
const event:WindowedEvent={eventId:"e",eventType:"ANOMALY_DETECTION",schemaVersion:"1.0",idempotencyKey:"k",traceId:"t",occurredAt:"2026-01-08T00:15:00Z",producedAt:"2026-01-08T00:16:00Z",source:"ingestion",payload:{window:{start:"2026-01-08T00:00:00Z",end:"2026-01-08T00:15:00Z",grainSeconds:900},inputWatermark:"2026-01-08T00:15:00Z",datasetVersion:"d"}};

test("MAD usa somente dias anteriores e detecta o bucket atual",()=>{
  const rows:Observation[]=[];
  for(let point=0;point<7*96;point++){const at=new Date(Date.parse("2026-01-01T00:00:00Z")+point*900000).toISOString();rows.push({id:`h${point}`,datasetVersion:"d",scopeId:"s",metric:"buffer",unit:"ratio",timestamp:at,grainSeconds:900,value:point%2?1:1.2});}
  rows.push({id:"current",datasetVersion:"d",scopeId:"s",metric:"buffer",unit:"ratio",timestamp:"2026-01-08T00:00:00Z",grainSeconds:900,value:4});
  const result=infer(model,event,scope,rows); const signal=result.signals.find(s=>s.detector==="univariate-robust-z");
  assert.ok(signal); assert.ok(signal.score>signal.threshold.value); assert.equal(result.historyDays,7); assert.equal(result.coverage,1);
});

test("observação desalinhada é rejeitada em vez de contaminar janelas",()=>{
  const row:Observation={id:"x",datasetVersion:"d",scopeId:"s",metric:"buffer",unit:"ratio",timestamp:"2026-01-01T00:01:00Z",grainSeconds:900,value:1};
  assert.throws(()=>cleanObservations([row],"d",scope,Date.parse("2026-01-01T00:00:00Z"),Date.parse("2026-01-01T01:00:00Z")),/INVALID_OBSERVATION/);
});

test("matriz de precisão assimétrica ou não positiva é recusada",()=>{
  const invalid=structuredClone(model); invalid.detection.scopes.s!.precision=[[1,2],[0,1]];
  assert.throws(()=>validateBundle(invalid),/INVALID_DETECTOR_PRECISION/);
});

test("matriz positiva em escalas muito diferentes é aceita",()=>{
  const scaled=structuredClone(model); scaled.detection.scopes.s!.precision=[[1,0],[0,1e-12]];
  assert.doesNotThrow(()=>validateBundle(scaled));
});

test("catálogo aceita a mesma métrica em 15 minutos e uma hora, com séries distintas",()=>{
  const catalog=validateScopes([{id:"s",source:"argus",entity:"canal",priority:"P2",detectorMetrics:["buffer"],series:[
    {metric:"buffer",seriesId:"buffer-15m",unit:"ratio",grainSeconds:900},{metric:"buffer",seriesId:"buffer-1h",unit:"ratio",grainSeconds:3600},
  ]}]);
  assert.equal(catalog[0]?.series.length,2);
});
