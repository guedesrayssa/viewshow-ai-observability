import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../../../../../assets/testes-carga/2026-10-07-revisao');
const base = process.env.RETRO_GRAFANA_URL || 'http://127.0.0.1:13003';
const auth = 'Basic '+Buffer.from('lab:local-rnf-only').toString('base64');
await mkdir(output, { recursive: true });
let datasourceReady = false;
for (let attempt=0; attempt<30; attempt++) {
  try {
    const response = await fetch(base+'/api/datasources/uid/rnf-retro/health', {headers:{Authorization:auth},signal:AbortSignal.timeout(3000)});
    datasourceReady = response.ok && (await response.json()).status === 'OK';
  } catch { /* Grafana may be registering its bundled datasource at startup. */ }
  if (datasourceReady) break;
  await new Promise(resolve=>setTimeout(resolve,1000));
}
if (!datasourceReady) throw new Error('Retrospective datasource is not ready');
const validations = [];
for (const kind of ['api', 'ingestao', 'fila']) {
  const dashboard = JSON.parse(await readFile(resolve(here, `provisioning/dashboards/rnf-retro-${kind}.json`)));
  const from = Date.parse(dashboard.time.from), to = Date.parse(dashboard.time.to);
  const checks = [];
  for (const panel of dashboard.panels) {
    const response = await fetch(base+'/api/ds/query', {
      method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: String(from), to: String(to), queries: panel.targets.map(t => ({
        ...t, datasource: { type: 'prometheus', uid: 'rnf-retro' }, intervalMs: 5000,
        maxDataPoints: 1000, format: 'time_series', instant: false,
      })) }),
    });
    const body = await response.json();
    await writeFile(resolve(output, `grafana-${kind}-panel-${panel.id}.json`), JSON.stringify(body, null, 2)+'\n');
    for (const target of panel.targets) {
      const result = body.results?.[target.refId];
      const errors = [result?.error, result?.errorMessage].filter(Boolean);
      let samples = 0;
      for (const frame of result?.frames || []) {
        frame.schema.fields.forEach((field, i) => {
          if (field.type === 'number') samples += frame.data.values[i].filter(v => typeof v === 'number' && Number.isFinite(v)).length;
        });
      }
      checks.push({ panelId: panel.id, refId: target.refId, expression: target.expr,
        httpStatus: response.status, samples, errors,
        passed: response.ok && samples > 0 && errors.length === 0 });
    }
  }
  const validation = { dashboard: dashboard.uid, window: dashboard.time,
    kind: 'native Grafana rendering over preserved data; no new measurement',
    checks, passed: checks.every(c => c.passed) };
  validations.push(validation);
  await writeFile(resolve(output, `grafana-${kind}-validation.json`), JSON.stringify(validation, null, 2)+'\n');
  if (!validation.passed) throw new Error(`Missing samples or datasource error in ${kind}`);
  const url = new URL(`/render/d/${dashboard.uid}/evidencias`, base);
  for (const [key,value] of Object.entries({ from, to, width:1800, height:820, tz:'UTC', kiosk:'true', timeout:90 })) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Authorization:auth }, signal:AbortSignal.timeout(120000) });
  const png = Buffer.from(await response.arrayBuffer());
  if (!response.ok || png.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Grafana did not return a PNG');
  await writeFile(resolve(output, `grafana-${kind}.png`), png);
  {
    for (const panel of dashboard.panels) {
      const solo = new URL(`/render/d-solo/${dashboard.uid}/evidencias`, base);
      for (const [key, value] of Object.entries({from, to, width:1100, height:470, panelId:panel.id, tz:'UTC', timeout:90})) solo.searchParams.set(key,value);
      const rendered = await fetch(solo, {headers:{Authorization:auth},signal:AbortSignal.timeout(120000)});
      const bytes = Buffer.from(await rendered.arrayBuffer());
      if (!rendered.ok || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid native panel image');
      await writeFile(resolve(output, `grafana-${kind}-panel-${panel.id}.png`), bytes);
    }
  }
  console.log(JSON.stringify({dashboard:dashboard.uid,checks:checks.length,samples:checks.map(c=>c.samples),passed:true,pngBytes:png.length}));
}
await writeFile(resolve(output, 'observability-validation.json'), JSON.stringify({checks:validations.flatMap(v=>v.checks),passed:true}, null,2)+'\n');
