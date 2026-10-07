import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanObservations, prepareContext, prepareDiagnosisProjection } from "../src/worker/facts.js";
import { infer, validateBundle, type ModelBundle } from "../src/worker/models.js";
import { validateScopes } from "../src/worker/config.js";
import { canonicalSeriesIdentity, seriesId } from "../src/worker/series-id.js";
import { isMaterial } from "../src/worker/orchestrator.js";
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

test("limpeza preserva a mesma métrica em grãos diferentes",()=>{
  const mixed:AnalysisScope={...scope,series:[{metric:"buffer",seriesId:"15m",unit:"ratio",grainSeconds:900},{metric:"buffer",seriesId:"1h",unit:"ratio",grainSeconds:3600}]};
  const base={datasetVersion:"d",scopeId:"s",metric:"buffer",unit:"ratio",timestamp:"2026-01-01T00:00:00Z",value:1};
  const clean=cleanObservations([{...base,id:"15m",grainSeconds:900},{...base,id:"1h",grainSeconds:3600}],"d",mixed,Date.parse(base.timestamp),Date.parse("2026-01-01T01:00:00Z"));
  assert.equal(clean.length,2);
});

test("seriesId é estável mesmo quando dimensões chegam em outra ordem",()=>{
  const base={logicalDataset:"live_active_15min",source:"argus",entity:"globo-rj",metric:"active_sessions"};
  assert.equal(seriesId({...base,dimensions:{channel:"globo-rj",region:"br"}}),seriesId({...base,dimensions:{region:"br",channel:"globo-rj"}}));
  assert.equal(seriesId({...base,dimensions:{channel:"globo-rj"}}),"ts_39328613a9667d827a298acd1cde08c064374a42764895e5e302f580f55b1b04");
  assert.match(canonicalSeriesIdentity(base),/^\{"logicalDataset"/);
});

test("gate de materialidade exige volume mínimo na janela corrente",()=>{
  const gated:AnalysisScope={...scope,materiality:[{metric:"buffer",minimum:10}]};
  const row:Observation={id:"m",datasetVersion:"d",scopeId:"s",metric:"buffer",unit:"ratio",timestamp:event.payload.window.start,grainSeconds:900,value:9};
  assert.equal(isMaterial([row],event,gated),false);
  assert.equal(isMaterial([{...row,value:10}],event,gated),true);
});

test("catálogo valida regras de materialidade e janela de episódio",()=>{
  const valid={...scope,materiality:[{metric:"buffer",minimum:10}],episodeWindowSeconds:7200};
  assert.doesNotThrow(()=>validateScopes([valid]));
  assert.throws(()=>validateScopes([{...valid,episodeWindowSeconds:86400}]),/INVALID_EPISODE_WINDOW/);
});

test("projeção do diagnóstico usa somente observações persistidas na janela",()=>{
  const presented:AnalysisScope={
    ...scope,
    series:[
      ...scope.series,
      {metric:"bufferratio_avg",seriesId:"buffering",unit:"ratio",grainSeconds:900},
      {metric:"errors_model_a",seriesId:"model-a",unit:"count",grainSeconds:900},
      {metric:"errors_model_b",seriesId:"model-b",unit:"count",grainSeconds:900},
      {metric:"affected_devices",seriesId:"affected-devices",unit:"devices",grainSeconds:900},
    ],
    presentation:{
      affectedDevicesMetric:"affected_devices",
      bufferingMetric:"bufferratio_avg",
      bufferingScale:100,
      concentrations:[{metric:"errors_model_a",label:"model-a"},{metric:"errors_model_b",label:"model-b"}],
      concentrationNote:"Erros por modelo na última hora.",
    },
  };
  const rows:Observation[]=[];
  const end=Date.parse(event.payload.window.end);
  for(let index=0;index<8;index++){
    const timestamp=new Date(end-(8-index)*900000).toISOString();
    rows.push({id:`b${index}`,datasetVersion:"d",scopeId:"s",metric:"bufferratio_avg",unit:"ratio",timestamp,grainSeconds:900,value:(index+1)/1000});
    rows.push({id:`a${index}`,datasetVersion:"d",scopeId:"s",metric:"errors_model_a",unit:"count",timestamp,grainSeconds:900,value:index<4?1:3});
    rows.push({id:`m${index}`,datasetVersion:"d",scopeId:"s",metric:"errors_model_b",unit:"count",timestamp,grainSeconds:900,value:1});
    rows.push({id:`d${index}`,datasetVersion:"d",scopeId:"s",metric:"affected_devices",unit:"devices",timestamp,grainSeconds:900,value:index<7?2:3});
  }

  const projection=prepareDiagnosisProjection(rows,event,presented);

  assert.deepEqual(projection?.buffering?.points.map(point=>point.value),[0.1,0.2,0.3,0.4,0.5,0.6,0.7000000000000001,0.8]);
  assert.deepEqual(projection?.concentrations,[{label:"model-a",percentage:75},{label:"model-b",percentage:25}]);
  assert.deepEqual(projection?.impact.affectedDevices,{
    value:3,
    observedThrough:event.payload.window.end,
    coverageRatio:1,
    source:"analysis-worker:s:affected_devices:incident-start-bucket",
  });
  assert.equal(projection?.concentrationNote,"Erros por modelo na última hora.");
});

test("catálogo rejeita apresentação ligada a série inexistente",()=>{
  assert.throws(()=>validateScopes([{...scope,presentation:{bufferingMetric:"missing"}}]),/INVALID_PRESENTATION_BUFFERING_METRIC/);
});

test("projeção é inferida para qualquer escopo com métricas canônicas",()=>{
  const generic:AnalysisScope={
    ...scope,
    series:[
      ...scope.series,
      {metric:"bufferratio_avg",seriesId:"buffering",unit:"ratio",grainSeconds:900},
      {metric:"active_with_error",seriesId:"affected",unit:"count",grainSeconds:900},
      {metric:"cdn_live_err_rate",seriesId:"cdn",unit:"percent",grainSeconds:900},
      {metric:"origin_live_err_rate",seriesId:"origin",unit:"percent",grainSeconds:900},
      {metric:"origin_cdn_live_err_rate",seriesId:"mixed",unit:"percent",grainSeconds:900},
    ],
  };
  const rows:Observation[]=[
    {id:"buffer",datasetVersion:"d",scopeId:"s",metric:"bufferratio_avg",unit:"ratio",timestamp:event.payload.window.start,grainSeconds:900,value:.04},
    {id:"affected",datasetVersion:"d",scopeId:"s",metric:"active_with_error",unit:"count",timestamp:event.payload.window.start,grainSeconds:900,value:7},
    {id:"cdn",datasetVersion:"d",scopeId:"s",metric:"cdn_live_err_rate",unit:"percent",timestamp:event.payload.window.start,grainSeconds:900,value:6},
    {id:"origin",datasetVersion:"d",scopeId:"s",metric:"origin_live_err_rate",unit:"percent",timestamp:event.payload.window.start,grainSeconds:900,value:3},
    {id:"mixed",datasetVersion:"d",scopeId:"s",metric:"origin_cdn_live_err_rate",unit:"percent",timestamp:event.payload.window.start,grainSeconds:900,value:1},
  ];

  const projection=prepareDiagnosisProjection(rows,event,generic);

  assert.equal(projection?.impact.affectedDevices?.value,7);
  assert.deepEqual(projection?.buffering?.points,[{timestamp:event.payload.window.start,value:4}]);
  assert.deepEqual(projection?.concentrations,[
    {label:"CDN",percentage:60},
    {label:"Origem",percentage:30},
    {label:"Origem/CDN",percentage:10},
  ]);
});
