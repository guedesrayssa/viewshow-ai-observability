import copy
import json
import unittest
import tempfile
from pathlib import Path

from runner import BUDGET, BudgetError, ProtocolError, Tools, investigate, revise, validate
from prepare import reserved, HOUR
from evaluate import assess_reviews, packets, summarize


def fixture():
    c = dict(id='test', synthetic=True, cutoff='2026-01-01T06:00:00Z',
             signal=dict(metric='bufferratio_avg',scope='sinal:target'),
             reference_window=dict(start='2026-01-01T00:00:00Z',end='2026-01-01T03:00:00Z',expected_points=3),
             current_window=dict(start='2026-01-01T03:00:00Z',end='2026-01-01T06:00:00Z',expected_points=3),records=[])
    for h in range(7):
        for metric,value in [('bufferratio_avg',2),('sessions',10 if h<3 else 100),('errors',1 if h<3 else 5),
                             ('errors_per_session',.1 if h<3 else .05),('startup_errors',0),('stalls_avg',.1)]:
            c['records'].append(dict(id=f'{metric}-{h}',timestamp=f'2026-01-01T0{h}:00:00Z',
                available_at=f'2026-01-01T0{h+1}:00:00Z',metric=metric,scope='sinal:target',value=value,unit='test',source='synthetic'))
    return c


def diagnosis(ids):
    return dict(observations=[dict(statement='Contagem e exposição variaram',evidence_ids=ids)],
                hypotheses=[],limitations=['Causa desconhecida'],
                next_checks=[dict(question='Qual categoria de erro?',required_data='logs',available_in_dataset=False)])


def reply(d=None,calls=None,reason='stop',tokens=50):
    return dict(done=True,done_reason=reason,eval_count=tokens,message=dict(role='assistant',content=json.dumps(d) if d else '',**({'tool_calls':calls} if calls else {})))


class Fake:
    def __init__(self,*responses):self.responses=list(responses);self.requests=[]
    def chat(self,payload,timeout):self.requests.append(copy.deepcopy(payload));return self.responses.pop(0)


class ComparisonTests(unittest.TestCase):
    def base_id(self,c):
        t=Tools(c);return t.call('contexto_base',{},2)['comparisons'][0]['id']

    def test_missing_causes_can_be_empty(self):
        self.assertEqual(validate(json.dumps(diagnosis(['x'])),{'x'})['hypotheses'],[])

    def test_unknown_citation_rejected(self):
        with self.assertRaises(ProtocolError):validate(json.dumps(diagnosis(['x'])),set())

    def test_observations_cannot_be_empty(self):
        d=diagnosis([]);d['observations']=[]
        with self.assertRaises(ProtocolError):validate(json.dumps(d),set())

    def test_pooled_rate_uses_exposure_and_paired_hours(self):
        c=fixture();c['records']=[r for r in c['records'] if r['id']!='sessions-4']
        t=Tools(c);rates=t.call('contexto_base',{},2)['pooled_rates']
        current=next(r for r in rates if r['metric']=='errors_per_session_pooled' and r['window']=='current')
        self.assertEqual(current['value'],.05);self.assertEqual(current['paired_hours'],2)
        self.assertEqual(current['denominator'],200)

    def test_zero_sessions_and_missing_are_not_zero_rates(self):
        c=fixture()
        for r in c['records']:
            if r['metric']=='sessions':r['value']=0
        rates=Tools(c).call('contexto_base',{},2)['pooled_rates']
        self.assertTrue(all(r['value'] is None and r['paired_hours']==0 for r in rates))

    def test_unseen_source_reference_not_citable(self):
        t=Tools(fixture());r=t.call('contexto_base',{},2)
        self.assertNotIn('errors-0',t.known)
        self.assertIn(r['comparisons'][0]['id'],t.known)

    def test_future_hour_not_exposed(self):
        t=Tools(fixture());r=t.call('consultar_serie',dict(metrics=['errors'],scope='all'),4)
        self.assertNotIn('errors-6',{x['id'] for x in r['records']})

    def test_same_core_in_A_and_B(self):
        c=fixture();rid=self.base_id(c)
        a=investigate(c,'A_prime',41,Fake(reply(diagnosis([rid]))),'fake')
        b=investigate(c,'B',41,Fake(reply(),reply(diagnosis([rid]))),'fake')
        self.assertEqual(a['status'],'ready');self.assertEqual(b['status'],'ready')
        self.assertEqual([t['response'] for t in a['tool_trace'][:2]],[t['response'] for t in b['tool_trace'][:2]])

    def test_actual_tool_result_is_used(self):
        c=fixture();call=dict(function=dict(name='consultar_serie',arguments=dict(metrics=['errors'],scope='sinal:target')))
        client=Fake(reply(calls=[call]),reply(),reply(diagnosis(['errors-0'])))
        b=investigate(c,'B',41,client,'fake')
        self.assertEqual(b['status'],'ready');self.assertIn('errors-0',client.requests[1]['messages'][-1]['content'])

    def test_forbidden_tool_stops(self):
        client=Fake(reply(calls=[dict(function=dict(name='shell',arguments={}))]))
        r=investigate(fixture(),'B',41,client,'fake');self.assertEqual(r['status'],'failed')

    def test_truncation_is_not_validated(self):
        c=fixture();r=investigate(c,'A_prime',41,Fake(reply(diagnosis([self.base_id(c)]),reason='length')),'fake')
        self.assertEqual(r['status'],'budget_exceeded');self.assertIsNone(r['diagnosis'])

    def test_byte_budget_stops_before_network(self):
        client=Fake();r=investigate(fixture(),'A_prime',41,client,'fake',{**BUDGET,'input_bytes_per_call':1})
        self.assertEqual(r['status'],'budget_exceeded');self.assertFalse(client.requests)

    def test_review_pair_has_identical_evidence_and_shared_cost(self):
        c=fixture();d=diagnosis([self.base_id(c)]);b=investigate(c,'B',41,Fake(reply(),reply(d)),'fake')
        b['run_id']='base';original=copy.deepcopy(b)
        cc,ss=Fake(reply(d)),Fake(reply(d))
        cr=revise(b,'C',c,cc,'fake');sr=revise(b,'B_self',c,ss,'fake')
        self.assertEqual(cr['status'],'ready');self.assertEqual(sr['status'],'ready')
        self.assertEqual(cc.requests[0]['messages'][1],ss.requests[0]['messages'][1])
        self.assertEqual(cr['base_sha256'],sr['base_sha256']);self.assertEqual(b,original)
        self.assertEqual(cr['output_tokens'],150);self.assertEqual(cr['actual_new_output_tokens'],50)
        self.assertEqual(cr['elapsed_ms']>=b['elapsed_ms'],True)

    def test_review_cannot_cite_new_observations(self):
        c=fixture();b=investigate(c,'B',41,Fake(reply(),reply(diagnosis([self.base_id(c)]))),'fake')
        r=revise(b,'C',c,Fake(reply(diagnosis(['errors-0']))),'fake')
        self.assertEqual(r['status'],'failed')

    def test_schema_exposes_only_received_ids(self):
        c=fixture();client=Fake(reply(diagnosis([self.base_id(c)])))
        r=investigate(c,'A_prime',41,client,'fake')
        allowed=client.requests[-1]['format']['properties']['observations']['items']['properties']['evidence_ids']['items']['enum']
        self.assertEqual(set(allowed),set(r['queried_evidence_ids']))
        self.assertNotIn('errors-6',allowed)

    def test_review_budget_includes_base_tokens(self):
        c=fixture();b=investigate(c,'B',41,Fake(reply(),reply(diagnosis([self.base_id(c)]))),'fake')
        client=Fake();r=revise(b,'C',c,client,'fake',{**BUDGET,'output_tokens':100})
        self.assertEqual(r['status'],'budget_exceeded');self.assertFalse(client.requests)

    def test_failed_upstream_cannot_disappear_from_C(self):
        c=fixture();b=investigate(c,'B',41,Fake(reply(),reply({'bad':True})),'fake');client=Fake()
        r=revise(b,'C',c,client,'fake');self.assertEqual(r['status'],'upstream_failed');self.assertFalse(client.requests)

    def test_old_dates_and_temporal_guard_are_reserved(self):
        c=fixture();start=int(__import__('datetime').datetime(2026,1,1,tzinfo=__import__('datetime').timezone.utc).timestamp()*1000)
        self.assertTrue(reserved(start//(6*HOUR),[c]));self.assertTrue(reserved(start//(6*HOUR)+3,[c]))
        self.assertFalse(reserved(start//(6*HOUR)+5,[c]))

    def test_human_reviews_cannot_mix_batches(self):
        with self.assertRaises(ValueError):assess_reviews({'batch_hash':'a'}, {'batch_hash':'b'})

    def test_review_pipeline_preserves_human_work_and_includes_failed_runs(self):
        from runner import HERE, save
        c=fixture();rid=self.base_id(c)
        policy=json.loads((HERE/'protocol.json').read_text())
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);plan=[]
            for variant in ('A_prime','B','C','B_self'):
                if variant=='A_prime':
                    r=investigate(c,variant,41,Fake(reply(diagnosis([rid]))),'fake')
                elif variant=='B':
                    r=investigate(c,variant,41,Fake(reply(),reply(diagnosis([rid]))),'fake');base=copy.deepcopy(r)
                else:
                    r=revise(base,variant,c,Fake(reply(diagnosis([rid]))),'fake')
                r['run_id']='run-test-'+variant
                if variant=='A_prime':r.update(status='failed',diagnosis=None,error='Fixture failure')
                save(root/(r['run_id']+'.json'),r);plan.append(dict(id=r['run_id']))
            save(root/'plan.json',plan);save(root/'dataset.json',dict(cases=[c]))
            save(root/'manifest.json',dict(protocol=dict(policy=policy)))
            packets(root)
            with self.assertRaises(ValueError):packets(root)
            bundle=json.loads((root/'review-packets.json').read_text())
            self.assertTrue(all('variant' not in card for card in bundle['packets']))
            values={card['review_id']:dict(scores={d:2 for d in policy['dimensions']},critical_error=False,
                   critical_codes=[],notes='Fixture only',reviewer='test') for card in bundle['packets'] if card['status']=='ready'}
            save(root/'ratings.json',dict(batch_hash=bundle['batch_hash'],ratings=values))
            import contextlib,io
            with contextlib.redirect_stdout(io.StringIO()):summarize(root,root/'ratings.json')
            summary=json.loads((root/'reviewed-summary.json').read_text())
            self.assertTrue(summary['human_review_complete'])
            self.assertEqual(summary['groups']['A_prime']['mean_quality'],0)
            self.assertEqual(summary['groups']['B']['mean_quality'],8)


if __name__=='__main__':unittest.main()
