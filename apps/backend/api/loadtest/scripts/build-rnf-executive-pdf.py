"""Build the reader-facing executive PDF from preserved RNF evidence."""
import json
import os
from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak

ROOT=Path(__file__).resolve().parents[5]
AWS=ROOT/'assets/testes-carga/2026-10-06-fechamento-aws'
LOCAL=ROOT/'assets/testes-carga/2026-10-06-fechamento-local'
RETRO=ROOT/'assets/testes-carga/2026-10-07-revisao'
OUTPUT=ROOT/'output/pdf/sintese-testes-nao-funcionais.pdf'
OUTPUT.parent.mkdir(parents=True,exist_ok=True)
font_dir=Path(os.environ['RNF_FONT_DIR'])
for name,file in [('DejaVu','DejaVuSans.ttf'),('DejaVu-Bold','DejaVuSans-Bold.ttf'),('DejaVu-Mono','DejaVuSansMono.ttf')]:
    pdfmetrics.registerFont(TTFont(name,str(font_dir/file)))
navy=colors.HexColor('#143047');teal=colors.HexColor('#087F83');muted=colors.HexColor('#4D6070');pale=colors.HexColor('#EEF4F6')
styles=getSampleStyleSheet()
styles.add(ParagraphStyle(name='TitleRNF',fontName='DejaVu-Bold',fontSize=24,leading=28,textColor=navy,spaceAfter=12))
styles.add(ParagraphStyle(name='H2RNF',fontName='DejaVu-Bold',fontSize=15,leading=19,textColor=navy,spaceBefore=10,spaceAfter=9))
styles.add(ParagraphStyle(name='BodyRNF',fontName='DejaVu',fontSize=10,leading=14,textColor=navy,spaceAfter=8))
styles.add(ParagraphStyle(name='SmallRNF',fontName='DejaVu',fontSize=8.6,leading=12,textColor=muted,spaceAfter=7))
styles.add(ParagraphStyle(name='CellRNF',fontName='DejaVu',fontSize=9,leading=12,textColor=navy))
styles.add(ParagraphStyle(name='CodeRNF',fontName='DejaVu-Mono',fontSize=7.5,leading=10,textColor=navy,splitLongWords=True))


def para(text,style='BodyRNF'):
    return Paragraph(text,styles[style])


def table(rows,widths):
    cells=[[para(str(v),'CellRNF') for v in row] for row in rows]
    t=Table(cells,colWidths=widths,repeatRows=1,hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),pale),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),('LINEBELOW',(0,0),(-1,0),0.8,teal),('LINEBELOW',(0,1),(-1,-1),0.25,colors.HexColor('#D7E1E7'))]))
    return t


def furniture(canvas,doc):
    canvas.saveState();w,h=A4
    canvas.setFillColor(teal);canvas.rect(36,h-26,w-72,3,fill=1,stroke=0)
    canvas.setFont('DejaVu-Bold',8);canvas.setFillColor(muted)
    canvas.drawString(36,h-42,'VIEW SHOW  /  SPRINT 5  /  TESTES NAO FUNCIONAIS')
    canvas.setFont('DejaVu',8);canvas.drawString(36,24,'Revisao 07 outubro 2026 - coletas identificadas em UTC')
    canvas.drawRightString(w-36,24,f'{doc.page}')
    canvas.restoreState()


stream=json.loads((LOCAL/'stream-validated/stream-summary.json').read_text())
large=json.loads((AWS/'independent-count-750000.json').read_text())
replicas=json.loads((AWS/'nominal-repetitions/summary.json').read_text()) if (AWS/'nominal-repetitions/summary.json').exists() else []
story=[]
story += [para('Carga, resiliência<br/>e observabilidade','TitleRNF'),para('Evolução dos testes da Sprint 3, com cenários executáveis, resultados auditáveis e impacto nas decisões de arquitetura. Develop d5339f3 incorporado; a linha de base ECS e um EKS dedicado foram medidos separadamente.','BodyRNF')]
story += [table([['Critério','Peso','Entrega verificável'],['Planos de RNFs','3,0','Cenários, pré-condições, massa, procedimento, métricas e aceite objetivo.'],['Resultados e análise','4,0','Carga real, falha injetada, recuperação, recontagem independente e limites de interpretação.'],['Grafana / Prometheus','3,0','Quatro indicadores com amostras reais, queries preservadas e gate por expressão visível.']],[130,45,348]),Spacer(1,13)]
story += [para('Resultados centrais','H2RNF'),table([['Experimento','Medido','Conclusão'],['Chegada contínua local','150.000 eventos / 15 min; p95 do lote 1,179 s','150.000 verificados; sem faltantes, duplicados ou diferenças canônicas.'],['Volume AWS','750.000 em 23 datasets recontados','INGESTING completo; pipeline não concluiu no orçamento de 75 min.'],['EKS nominal','150 mil; PROCESSING após 904,60 s','Reprovado/censurado; o smoke de 1.000 chegou a READY em 120,648 s.'],['API EKS 137/s','43.198 req; p95 geral 8 s; 93,990% de falha','HPA 1→4 não evitou saturação; 1.003 chegadas descartadas.'],['Falha e recuperação','MySQL bloqueado: 2 tentativas / 2,017 s','Recupera a mesma página em 5,866 ms após liberar o lock.'],['Frontend autenticado','18 auditorias; FCP móvel até 1,173 s','Três telas e API real; LCP móvel ultrapassa a referência de 2,5 s.']],[130,175,218])]
story += [Spacer(1,10),para('<b>Perfis:</b> nominal 150 mil/900 s; 2× volume 300 mil/1.800 s; 5× volume 750 mil/4.500 s. Batch sem rampa. Contínuo: 1.000 eventos/6 s durante 900 s, 150 mil no total. Os multiplicadores são de volume; taxas de chegada 20/50 mil por minuto ainda são planos futuros.','SmallRNF')]
story += [PageBreak(),para('API EKS: latência e vazão','TitleRNF'),para('Conta 239162056821, us-east-1. Janela: 07/10 02:04:45-02:10:45 UTC. Exportação retrospectiva nativa do Grafana sobre frames Prometheus preservados. A taxa oferecida de 137/s não se converteu em throughput útil.','BodyRNF')]
for panel,caption in [(1,'O p95 chega perto de 8 s, acima do critério de 2 s. K6 inclui também rede e timeout do cliente.'),(2,'A vazão do servidor oscila em poucos req/s. Requisições que falham no balanceador ou expiram podem não entrar nessa série.')]:
    story.append(Image(str(RETRO/f'grafana-api-panel-{panel}.png'),width=523,height=226.6));story.append(para(caption,'SmallRNF'));story.append(Spacer(1,12))
story += [PageBreak(),para('API EKS: erros e CPU','TitleRNF'),para('A fórmula corrigida de CPU soma os containers em percentual de um núcleo. O gate da visualização confirma 73 amostras por indicador; as séries não são uma nova carga.','BodyRNF')]
for panel,caption in [(3,'São os 5xx que alcançaram o processo. O k6 contou também 29.292 respostas com status 0 e 12.323 respostas 503 na rodada.'),(4,'Percentual agregado de um núcleo, podendo superar 100% com réplicas. Não usar a antiga divisão por número de Pods com scrape saudável.')]:
    story.append(Image(str(RETRO/f'grafana-api-panel-{panel}.png'),width=523,height=226.6));story.append(para(caption,'SmallRNF'));story.append(Spacer(1,12))
story += [PageBreak(),para('Método, decisões e rastreabilidade','TitleRNF')]
story += [para(f'<b>Repetibilidade:</b> {len(replicas)}/3 repetições com resultado fechado na geração desta edição. Cada massa tem 150.000 registros, distribuição de uma janela e hash independente; orçamento de 900 s pré-definido. Não combinar percentis ou versões históricas como se fossem amostras do mesmo perfil.','BodyRNF')]
story += [para('Capacidade do lote de 150 mil (ECS, 04/10)','H2RNF'),table([['Etapa','Tempo','Taxa média'],['INGESTING','447,512 s','20.111 eventos/min'],['PROJECTING','958,073 s','9.394 eventos/min'],['ARCHIVING','778,185 s','11.565 eventos/min']],[190,135,198]),para('Em sequência, os tempos se somam: 2.183,770 s → 4.121 eventos/min. r_total = 1/(1/r1+1/r2+1/r3). Os 3.956 medidos pelo k6 incluem partida e polling. CPU de ~21% na ingestão/projeção; arquivo chega a 50,9% de duas vCPUs, um núcleo ocupado.','SmallRNF')]
story += [table([['Evidência','Decisão / limite'],['Taxa sequencial abaixo de 10 mil/min','Proposta: otimizar projeção e paralelismo limitado no arquivo.'],['750 mil censurado após o prazo','Contagem independente não aprova conclusão end-to-end; cancelamento é operacional, não deadline nativo.'],['RS-06: zero 429 na URL pública','Proposta: identificar cliente pela cadeia de proxies confiáveis e repetir público/direto.'],['Heartbeat drena 2/3/4 lotes','Implementado e medido em ECS. Alarme por idade já existe; janela e cobertura precisam revisão.'],['Probes da API falham sob saturação','Proposta: contrapressão, cancelamento e revisão de saúde antes de repetir carga.']],[202,321]),Spacer(1,12)]
story += [para('Mapa para conferir a entrega','H2RNF'),para('<b>Artefato principal:</b> artefatos/testes-carga-finais.md<br/><b>Brutos e proveniência:</b> assets/testes-carga/2026-10-06-fechamento-local/ e 2026-10-06-fechamento-aws/<br/><b>Reprodução:</b> apps/backend/api/loadtest/lab/README.md<br/><b>Anexo:</b> artefatos/apoio/testes-carga-inventario.md - enumeração dos Dockerfiles, manifests e configurações. Grafana retrospectivo: apps/backend/api/loadtest/grafana-retroativo/README.md.','SmallRNF')]
story += [para('Limites que permanecem explícitos','H2RNF'),para('Laboratório e massas sintéticas; imagem implantada separada do commit; o EKS teve API e ingestão nativas, mas o nominal de 150 mil excedeu o orçamento; 17 testes de manifests e 14 de adaptadores não substituem essa carga; três auditorias não provam percentil populacional; login Cognito não medido; soak finito não prova disponibilidade mensal; erro da UI não aprova funcionalidade.','SmallRNF')]
story += [PageBreak(),para('Ingestão: o custo das etapas','TitleRNF'),para('ECS, 04/10 19:46:30-20:24:31 UTC. Mesma massa concentrada de 150 mil eventos. As durações são amostras agregadas de fim de etapa, não p95 nem uma série de latência contínua.','BodyRNF')]
for panel,caption in [(1,'PROJECTING é a maior etapa: 958 s, 43,9% dos três tempos somados; sozinho já excede os 900 s do nominal.'),(3,'CPU média ~21% na ingestão/projeção; ARCHIVING chega a 50,9% de duas vCPUs. Memória máxima cresce de 14,5% (150 mil) para 26,0% (300 mil), sem throttling DynamoDB.')]:
    story.append(Image(str(RETRO/f'grafana-ingestao-panel-{panel}.png'),width=523,height=226.6));story.append(para(caption,'SmallRNF'));story.append(Spacer(1,12))
story += [PageBreak(),para('Fila: acúmulo e recuperação','TitleRNF'),para('RS-01, três lotes de 150 mil. Fila cheia é backlog além da capacidade de consumo, não um pequeno limite rígido da SQS. Ao retomar o consumidor, 450 mil fatos foram persistidos e a DLQ permaneceu vazia.','BodyRNF')]
for panel,caption in [(1,'Três mensagens representam 450 mil eventos. O último lote concluiu em 1.334 s após reativar a agenda; o monitor confirmou fila vazia aos 1.371 s.'),(2,'A idade chega a ~1.762 s e cai depois da drenagem. É um sinal operacional de atraso, diferente de latência HTTP; alarme de idade existe, mas sua janela ainda não garante 30 s.')]:
    story.append(Image(str(RETRO/f'grafana-fila-panel-{panel}.png'),width=523,height=226.6));story.append(para(caption,'SmallRNF'));story.append(Spacer(1,12))
story += [para('Recuperação por falha','H2RNF'),para('RS-02a: 503 em 0,58 s e READY ~170 s após restaurar S3. RS-02b: FAILED ~130 s após parar worker, posse livre em ~5,5 min. RS-05: mensagem venenosa vai à DLQ em ~29 min úteis; válido +150 mil; alarme 131-158 s, acima de 30 s. Esses tempos pertencem a cenários distintos.','SmallRNF')]

doc=SimpleDocTemplate(str(OUTPUT),pagesize=A4,rightMargin=36,leftMargin=36,topMargin=60,bottomMargin=44,title='View Show - Sintese dos testes nao funcionais',author='Grupo 05 - View Show')
doc.build(story,onFirstPage=furniture,onLaterPages=furniture)
print(OUTPUT)
