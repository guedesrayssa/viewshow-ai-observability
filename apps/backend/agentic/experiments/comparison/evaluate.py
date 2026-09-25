"""Blind human-review packets and descriptive, case-paired summaries. No LLM judge."""
import argparse
import json
import math
import random
import statistics
from pathlib import Path

from runner import HERE, VARIANTS, DEFINITIONS, Tools, response_ids, digest, save


def flatten(value):
    result = {}
    if isinstance(value, dict):
        if isinstance(value.get('id'), str):
            result[value['id']] = value
        for x in value.values():
            result.update(flatten(x))
    elif isinstance(value, list):
        for x in value:
            result.update(flatten(x))
    return result


HTML = '''<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revisão das investigações</title><style>
body{font:16px system-ui;background:#f4f6f8;color:#192c3b;max-width:1000px;margin:auto;padding:24px}h1{font-size:26px}button,select,input{font:inherit;padding:8px}button{cursor:pointer}nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap;position:sticky;top:0;background:#f4f6f8;padding:12px 0}article,aside{background:white;padding:24px;border-radius:12px;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px ui-monospace;max-height:500px;overflow:auto}label{display:block;margin:12px 0}textarea{width:95%;min-height:110px;font:inherit}small{display:block;margin-top:8px;color:#425b6b}.tag{background:#e8edf2;padding:8px;border-radius:6px}summary{cursor:pointer;padding:8px}a{color:#175b9b}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:9px;border-bottom:1px solid #dbe3e9;text-align:left}#facts{overflow:auto}.finding{border-left:3px solid #689aaa;padding-left:14px;margin:14px 0}
</style><h1>Revisão das investigações</h1><p>Confira as respostas com os dados. A configuração está oculta; o estilo pode revelar pistas. Não há gabarito de causa raiz.</p>
<aside><b>Notas de 0 a 2</b><p>0: incorreto, omisso ou sem utilidade. 1: parcialmente adequado, com falha ou lacuna relevante. 2: adequado e sustentado. Avalie cada dimensão pelos dados, sem premiar apenas o estilo cauteloso.</p><p>Apoio factual inclui números, unidades, denominadores e canal. Contrapontos avalia informações que limitam a conclusão. Incerteza distingue observação de causa. Próximo passo avalia especificidade e pertinência; concluir que falta causa pode ser correto.</p><p>Marque erro crítico quando a resposta afirma causa inventada como fato, inverte o sentido da métrica, conclui sobre o canal errado ou usa um erro numérico que muda a interpretação. Justifique com evidências. Falhas de execução já contam no resumo operacional.</p></aside>
<nav><button id="prev">←</button><select id="pick"></select><button id="next">→</button><span id="progress"></span><button id="export">Exportar avaliações</button><label>Importar <input id="import" type="file" accept="application/json"></label></nav>
<article><div id="identity" class="tag"></div><h2>Resposta para avaliar</h2><div id="answer"></div><h2>Conferência dos dados do alvo</h2><div id="facts"></div><small>Comparações descritivas; diferenças não confirmam incidentes. Valores de buffering mantidos na escala original.</small><details><summary>Definições, observações por hora e IDs das evidências</summary><pre id="evidence"></pre></details><details><summary>Resposta estruturada original</summary><pre id="rawanswer"></pre></details><div id="scores"></div><label><input type="checkbox" id="critical"> Há erro crítico</label><label>Códigos de erro crítico (separados por vírgula)<input id="codes" style="width:95%" placeholder="reversed_metric_meaning"></label><small>invented_cause_as_fact · reversed_metric_meaning · wrong_target_conclusion · material_numeric_error</small><label>Justificativa e IDs das evidências<textarea id="notes"></textarea></label><button id="save">Salvar avaliação desta resposta</button><small id="message"></small></article>
<script type="application/json" id="data">__DATA__</script><script>
const bundle=JSON.parse(document.getElementById('data').textContent),cards=bundle.packets,dims=bundle.dimensions;
const names={factual_support:'Apoio factual',contradictions:'Tratamento de contrapontos',uncertainty:'Reconhecimento de incerteza',next_step_usefulness:'Utilidade do próximo passo'};
const key='viewshow-review-'+bundle.batch_hash;let ratings={};try{ratings=JSON.parse(localStorage.getItem(key)||'{}')}catch{}let index=0;
const el=id=>document.getElementById(id),put=(id,x)=>el(id).textContent=x;
cards.forEach((c,i)=>{let o=document.createElement('option');o.value=i;o.textContent=c.review_id;el('pick').appendChild(o)});
dims.forEach(d=>{let label=document.createElement('label');label.textContent=names[d]+' ';let s=document.createElement('select');s.id=d;['','0','1','2'].forEach(v=>{let o=document.createElement('option');o.value=v;o.textContent=v||'Escolher';s.appendChild(o)});label.appendChild(s);el('scores').appendChild(label)});
function add(parent,tag,text){const n=document.createElement(tag);n.textContent=text;parent.appendChild(n);return n}
function render(c){el('answer').replaceChildren();el('facts').replaceChildren();if(!c.diagnosis)add(el('answer'),'p','Sem resposta válida. A falha já conta no resumo operacional.');else for(const [field,title]of [['observations','Observações'],['hypotheses','Causas candidatas'],['limitations','Limitações'],['next_checks','Próximas verificações']]){add(el('answer'),'h3',title);const rows=c.diagnosis[field]||[];if(!rows.length)add(el('answer'),'p',field==='hypotheses'?'Nenhuma causa candidata apresentada.':'Nenhum item apresentado.');for(const x of rows){let item=add(el('answer'),'div',typeof x==='string'?x:x.statement||x.question);item.className='finding';if(x.required_data)add(item,'small','Dados necessários: '+x.required_data+' · '+(x.available_in_dataset?'disponíveis no recorte':'fora do recorte'));const ids=x.evidence_ids||x.supporting_evidence_ids;if(ids?.length)add(item,'small','Apoio: '+ids.join(', '));if(x.contradicting_evidence_ids?.length)add(item,'small','Contrapontos: '+x.contradicting_evidence_ids.join(', '));}}
const fmt=x=>x==null?'Ausente':Number(x).toLocaleString('pt-BR',{maximumFractionDigits:6});const t=add(el('facts'),'table',''),head=add(t,'tr','');['Métrica','Referência','Atual','Diferença'].forEach(s=>add(head,'th',s));for(const x of c.facts.comparisons||[]){const row=add(t,'tr','');[x.metric,fmt(x.reference.mean),fmt(x.current.mean),fmt(x.delta)].forEach(s=>add(row,'td',s));}for(const x of c.facts.pooled_rates||[])add(el('facts'),'p',x.metric+' · '+(x.window==='reference'?'referência':'atual')+': '+fmt(x.value)+' eventos/sessão ('+x.paired_hours+'/'+x.expected_hours+' horas pareadas)');}
function show(){const c=cards[index],r=ratings[c.review_id]||{};el('pick').value=index;put('identity',c.review_id+' · cenário '+c.case_id+' · '+(c.status==='ready'?'resposta disponível':'falha de execução'));render(c);put('rawanswer',JSON.stringify(c.diagnosis||{falha:c.error},null,2));put('evidence',JSON.stringify({signal:c.signal,reference_window:c.reference_window,current_window:c.current_window,definitions:bundle.definitions,facts:c.facts,records:c.records,cited_evidence:c.cited_evidence},null,2));dims.forEach(d=>el(d).value=r.scores?.[d]??'');el('critical').checked=!!r.critical_error;el('codes').value=(r.critical_codes||[]).join(', ');el('notes').value=r.notes||'';put('progress',Object.keys(ratings).length+' / '+cards.length+' avaliações');put('message','');}
function valid(r){return r&&typeof r.notes==='string'&&r.notes.trim()&&typeof r.critical_error==='boolean'&&Array.isArray(r.critical_codes)&&r.critical_codes.every(c=>bundle.critical_codes.includes(c))&&(Boolean(r.critical_codes.length)===r.critical_error)&&dims.every(d=>Number.isInteger(r.scores?.[d])&&r.scores[d]>=0&&r.scores[d]<=2)}
function persist(){try{localStorage.setItem(key,JSON.stringify(ratings))}catch{put('message','Armazenamento local indisponível. Exporte o arquivo para preservar as notas.')}}
el('save').onclick=()=>{let r={scores:{},critical_error:el('critical').checked,critical_codes:el('codes').value.split(',').map(x=>x.trim()).filter(Boolean),notes:el('notes').value,reviewer:'primary_user'};dims.forEach(d=>r.scores[d]=el(d).value===''?null:Number(el(d).value));if(!valid(r)){put('message','Preencha as quatro notas, justifique e use códigos válidos quando houver erro crítico.');return}ratings[cards[index].review_id]=r;persist();put('progress',Object.keys(ratings).length+' / '+cards.length+' avaliações');put('message','Avaliação salva. Exporte um arquivo ao encerrar.');};
function move(n){index=Math.max(0,Math.min(cards.length-1,n));show()}el('prev').onclick=()=>move(index-1);el('next').onclick=()=>move(index+1);el('pick').onchange=()=>move(Number(el('pick').value));
el('export').onclick=()=>{const b=new Blob([JSON.stringify({batch_hash:bundle.batch_hash,ratings},null,2)],{type:'application/json'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='avaliacoes-viewshow.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};
el('import').onchange=async e=>{try{const v=JSON.parse(await e.target.files[0].text());if(v.batch_hash!==bundle.batch_hash||!v.ratings)throw Error('Lote diferente');for(const [id,r]of Object.entries(v.ratings)){if(!cards.some(c=>c.review_id===id)||!valid(r))throw Error('Avaliação inválida: '+id)}ratings={...ratings,...v.ratings};persist();show();put('message','Avaliações importadas.')}catch(e){put('message','Importação recusada: '+e.message)}};
if(cards.length)show();else put('identity','Nenhuma resposta concluída.');
</script></html>'''


def load_runs(root):
    plan = json.loads((root / 'plan.json').read_text())
    runs = [json.loads((root / (p['id']+'.json')).read_text()) for p in plan if (root / (p['id']+'.json')).exists()]
    return plan, runs


def packets(root):
    plan, runs = load_runs(root)
    if len(runs) != len(plan):
        raise ValueError('Generate final packets only after the complete plan')
    if (root / 'review-packets.json').exists():
        raise ValueError('Review packets already exist; preserving user work')
    dataset = json.loads((root / 'dataset.json').read_text())
    cases = {c['id']: c for c in dataset['cases']}
    policy = json.loads((root / 'manifest.json').read_text())['protocol']['policy']
    random.Random(policy['review_seed']).shuffle(runs)
    cards, mapping = [], {}
    for index, run in enumerate(runs, 1):
        rid = f'review-{index:03}'
        case = cases[run['case_id']]
        tool = Tools(case)
        facts = tool.call('contexto_base', {}, 1)
        evidence = flatten(run['tool_trace'])
        cards.append(dict(review_id=rid, case_id=case['id'], status=run['status'], error=run['error'],
                          signal=case['signal'], facts=facts, records=tool.records,
                          reference_window=case['reference_window'], current_window=case['current_window'],
                          cited_evidence=evidence, diagnosis=run['diagnosis']))
        mapping[rid] = {'run_id': run['run_id'], 'variant': run['variant'], 'case_id': case['id']}
    batch_hash = digest({'plan': plan, 'manifest': json.loads((root/'manifest.json').read_text()),
                         'runs': {r['run_id']: digest(r) for r in runs}})
    bundle = dict(batch_hash=batch_hash, definitions=DEFINITIONS, dimensions=policy['dimensions'],
                  critical_codes=policy['critical_error_codes'], packets=cards)
    save(root / 'review-packets.json', bundle)
    save(root / 'review-key.json', mapping)
    (root / 'review.html').write_text(HTML.replace('__DATA__', json.dumps(bundle, ensure_ascii=False).replace('<', '\\u003c')))


def assess_reviews(bundle, ratings):
    if ratings.get('batch_hash') != bundle['batch_hash']:
        raise ValueError('Reviews belong to another batch')
    known = {c['review_id'] for c in bundle['packets']}
    if set(ratings['ratings']) - known:
        raise ValueError('Unknown review identifiers')
    for rid, row in ratings['ratings'].items():
        if not isinstance(row.get('scores'), dict) or set(row['scores']) != set(bundle['dimensions']):
            raise ValueError('Incomplete dimensions: ' + rid)
        if any(type(v) is not int or not 0 <= v <= 2 for v in row['scores'].values()):
            raise ValueError('Invalid score: ' + rid)
        if type(row.get('critical_error')) is not bool or not isinstance(row.get('notes'), str) or not row['notes'].strip():
            raise ValueError('Missing review justification: ' + rid)
        codes = row.get('critical_codes')
        if not isinstance(codes, list) or any(c not in bundle['critical_codes'] for c in codes) or bool(codes) != row['critical_error']:
            raise ValueError('Invalid critical error codes: ' + rid)


def summarize(root, reviews=None):
    plan, runs = load_runs(root)
    policy = json.loads((root / 'manifest.json').read_text())['protocol']['policy']
    by_review, complete_reviews = {}, False
    if reviews:
        bundle = json.loads((root / 'review-packets.json').read_text())
        ratings = json.loads(reviews.read_text()); assess_reviews(bundle, ratings)
        key = json.loads((root / 'review-key.json').read_text())
        by_review = {key[k]['run_id']: v for k, v in ratings['ratings'].items()}
        complete_reviews = all(r['status'] != 'ready' or r['run_id'] in by_review for r in runs)
    result = dict(planned=len(plan), completed=len(runs), human_review_complete=bool(reviews and complete_reviews and len(runs)==len(plan)),
                  causal_accuracy=None, groups={}, comparisons={}, actual_new_llm_calls=sum(r['actual_new_llm_calls'] for r in runs))
    for variant in VARIANTS:
        rr = [r for r in runs if r['variant']==variant]
        if not rr:
            continue
        times = sorted(r['elapsed_ms']/1000 for r in rr)
        case_scores, errors = {}, 0
        for r in rr:
            review = by_review.get(r['run_id'])
            score = sum(review['scores'].values()) if review and r['status']=='ready' else 0 if r['status']!='ready' else None
            if score is not None:
                case_scores.setdefault(r['case_id'], []).append(score)
            errors += int(bool(review and review['critical_error'] and r['status']=='ready'))
        group = dict(completed=len(rr), ready=sum(r['status']=='ready' for r in rr),
                     mean_seconds=statistics.mean(times), p95_seconds=times[math.ceil(.95*len(times))-1],
                     deployment_equivalent_output_tokens=sum(r['output_tokens'] for r in rr),
                     actual_new_output_tokens=sum(r['actual_new_output_tokens'] for r in rr))
        if result['human_review_complete']:
            means = {c: statistics.mean(v) for c,v in case_scores.items()}
            group.update(case_mean_scores=means, mean_quality=statistics.mean(means.values()), critical_errors=errors)
            group['meets_observed_project_gates'] = (group['ready']/len(rr)>=policy['minimum_ready_fraction'] and
                group['p95_seconds']<=policy['maximum_p95_seconds'] and group['mean_quality']>=policy['minimum_mean_quality_0_to_8'] and
                errors<=policy['maximum_critical_errors_for_adoption'])
        result['groups'][variant]=group
    if result['human_review_complete']:
        for candidate, baseline in [('B','A_prime'),('C','B'),('C','B_self')]:
            a,b = result['groups'][candidate]['case_mean_scores'],result['groups'][baseline]['case_mean_scores']
            delta={c:a[c]-b[c] for c in a}
            gain=statistics.mean(delta.values()); net=sum(x>0 for x in delta.values())-sum(x<0 for x in delta.values())
            result['comparisons'][candidate+'_vs_'+baseline]=dict(case_differences=delta,mean_gain=gain,net_case_wins=net,
                meets_prespecified_gain=(gain>=policy['minimum_case_mean_gain_0_to_8'] and net>=policy['minimum_net_case_wins']))
    result['decision']='Human decision required; descriptive project thresholds do not establish population superiority.'
    save(root / ('reviewed-summary.json' if reviews else 'operational-summary.json'), result)
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['packets','summary']);p.add_argument('root',type=Path);p.add_argument('--reviews',type=Path)
    a=p.parse_args();packets(a.root) if a.action=='packets' else summarize(a.root,a.reviews)
