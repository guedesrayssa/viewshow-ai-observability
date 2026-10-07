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
    canvas.setFont('DejaVu',8);canvas.drawString(36,24,'06 outubro 2026 - evidencias em UTC; leitura executiva')
    canvas.drawRightString(w-36,24,f'{doc.page}')
    canvas.restoreState()


stream=json.loads((LOCAL/'stream-validated/stream-summary.json').read_text())
large=json.loads((AWS/'independent-count-750000.json').read_text())
replicas=json.loads((AWS/'nominal-repetitions/summary.json').read_text()) if (AWS/'nominal-repetitions/summary.json').exists() else []
story=[]
story += [para('Carga, resiliência<br/>e observabilidade','TitleRNF'),para('Evolução dos testes da Sprint 3, com cenários executáveis, resultados auditáveis e impacto nas decisões de arquitetura. Develop d5339f3 incorporado; a linha de base ECS e um EKS dedicado foram medidos separadamente.','BodyRNF')]
story += [table([['Critério','Peso','Entrega verificável'],['Planos de RNFs','3,0','Cenários, pré-condições, massa, procedimento, métricas e aceite objetivo.'],['Resultados e análise','4,0','Carga real, falha injetada, recuperação, recontagem independente e limites de interpretação.'],['Grafana / Prometheus','3,0','Quatro indicadores com amostras reais, queries preservadas e gate por expressão visível.']],[130,45,348]),Spacer(1,13)]
story += [para('Resultados centrais','H2RNF'),table([['Experimento','Medido','Conclusão'],['Chegada contínua local','150.000 eventos / 15 min; p95 do lote 1,179 s','150.000 verificados; sem faltantes, duplicados ou diferenças canônicas.'],['Volume AWS','750.000 em 23 datasets recontados','INGESTING completo; pipeline não concluiu no orçamento de 75 min.'],['Falha e recuperação','MySQL bloqueado: 2 tentativas / 2,017 s','Recupera a mesma página após liberar o lock; timeout é real.'],['Frontend autenticado','18 auditorias; FCP móvel até 1,173 s','Três telas e API real; LCP móvel ultrapassa a referência de 2,5 s.']],[130,175,218])]
story += [Spacer(1,10),para('<b>Uma reprovação não é ausência de entrega.</b> O resultado de capacidade foi preservado como falha; nenhuma configuração, janela ou imagem é atribuída a uma execução que não a mediu.','SmallRNF')]
story += [PageBreak(),para('Observabilidade durante a carga AWS','TitleRNF'),para('Conta 239162056821, us-east-1. Janela: 06/10 23:10-23:42 UTC. Latência, throughput e erros são das rotas de importação; CPU é da task import-dump sobre a reserva ECS. Throughput HTTP não é vazão de eventos.','BodyRNF')]
for panel,caption in [(1,'Latência p95 do plano de controle. Histograma do servidor; a medição k6 também inclui a internet.'),(2,'Throughput das rotas /imports. A atividade de consulta não representa a taxa de processamento do worker.')]:
    story.append(Image(str(AWS/f'grafana-panel-{panel}.png'),width=523,height=226.6));story.append(para(caption,'SmallRNF'));story.append(Spacer(1,12))
story += [PageBreak(),para('Erros e recurso utilizado','TitleRNF'),para('As imagens são exportações nativas do Grafana, sem redesenho das séries. O gate exige status 200, valores numéricos e nenhuma falha de datasource em cada query exibida.','BodyRNF')]
for panel,caption in [(3,'Erros/s nas rotas /imports. Zero foi derivado de um contador efetivamente coletado; ausência de série não é preenchida como sucesso.'),(4,'CPU usada / CPU reservada da família import-dump. Não confundir com CPU do processo por núcleo nem com CPU do gerador.')]:
    story.append(Image(str(AWS/f'grafana-panel-{panel}.png'),width=523,height=226.6));story.append(para(caption,'SmallRNF'));story.append(Spacer(1,12))
story += [PageBreak(),para('Método, decisões e rastreabilidade','TitleRNF')]
story += [para(f'<b>Repetibilidade:</b> {len(replicas)}/3 repetições com resultado fechado na geração desta edição. Cada massa tem 150.000 registros, distribuição de uma janela e hash independente; orçamento de 900 s pré-definido. Não combinar percentis ou versões históricas como se fossem amostras do mesmo perfil.','BodyRNF')]
story += [table([['Evidência','Decisão / limite'],['INGESTING atende isoladamente; projeção atrasa','Otimizar PROJECTING e ARCHIVING antes de aumentar CPU sem evidência.'],['750 mil censurado após o prazo','Contagem independente não aprova conclusão end-to-end; cancelamento é operacional, não deadline nativo.'],['LeaseBusy depois de interromper task','Respeitar o TTL da posse; mapear contenção para resposta retentável e observável.'],['Alarme em 18,448 s nesta amostra','Resultado pontual atende 30 s; período de 300 s e morte externa não garantem cobertura.'],['Dois grupos FIFO válidos chegam à DLQ','Reproducer de componente documenta a falha de posse global; RNF03 não é aprovado por ele.']],[202,321]),Spacer(1,12)]
story += [para('Mapa para conferir a entrega','H2RNF'),para('<b>Artefato principal:</b> artefatos/testes-carga-finais.md<br/><b>Brutos e proveniência:</b> assets/testes-carga/2026-10-06-fechamento-local/ e 2026-10-06-fechamento-aws/<br/><b>Reprodução:</b> apps/backend/api/loadtest/lab/README.md<br/><b>Inventário individual:</b> scripts, queries, Terraform e os três Dockerfiles, com base, dependências, COPY, build, inicialização, usuário, portas e .dockerignore.','SmallRNF')]
story += [para('Limites que permanecem explícitos','H2RNF'),para('Laboratório e massas sintéticas; imagem implantada separada do commit; o EKS teve API e ingestão nativas, mas o nominal de 150 mil excedeu o orçamento; 17 testes de manifests e 14 de adaptadores não substituem essa carga; três auditorias não provam percentil populacional; login Cognito não medido; soak finito não prova disponibilidade mensal; erro da UI não aprova funcionalidade.','SmallRNF')]
doc=SimpleDocTemplate(str(OUTPUT),pagesize=A4,rightMargin=36,leftMargin=36,topMargin=60,bottomMargin=44,title='View Show - Sintese dos testes nao funcionais',author='Grupo 05 - View Show')
doc.build(story,onFirstPage=furniture,onLaterPages=furniture)
print(OUTPUT)
