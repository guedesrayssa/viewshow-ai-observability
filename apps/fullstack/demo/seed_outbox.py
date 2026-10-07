"""Fixture local: MySQL → fatos/outbox DynamoDB → publicação pela ingestão real.

Executar dentro da imagem de ingestão. Nunca usa credenciais ou endpoints AWS.
O modelo constante de demonstração testa integração, não qualidade preditiva.
"""
from __future__ import annotations
import argparse
import json
import os
import time
import sys
sys.path.insert(0, "/app")
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import urlparse
import boto3
import pymysql
from adapters.dynamodb.outbox import build_analysis_event, pending_outbox, DynamoOutboxRepository
from domain.analysis import ForecastModel
from domain.models import TimeWindow
from domain.canonical_json import canonical_bytes

TABLE = "view-show-demo"
METRICS = {"bufferratio_avg": ("ratio", .13), "sessions": ("count", 100), "errors": ("count", 2), "startup_errors": ("count", 1)}


def client(service: str):
    """Retorna cliente local do serviço; recusa endpoint ausente ou externo."""
    endpoint = os.environ.get("AWS_ENDPOINT_URL_" + service.upper(), "")
    if urlparse(endpoint).hostname not in {"sqs", "dynamodb", "host.docker.internal", "127.0.0.1"}:
        raise RuntimeError("A demonstração exige endpoint local explícito")
    return boto3.client(service, endpoint_url=endpoint, region_name="us-east-1", aws_access_key_id="local", aws_secret_access_key="local")


def setup() -> None:
    """Cria tabela com índice de outbox e duas filas isoladas; retorna nada."""
    db = client("dynamodb")
    if TABLE not in db.list_tables()["TableNames"]:
        db.create_table(TableName=TABLE, BillingMode="PAY_PER_REQUEST", AttributeDefinitions=[{"AttributeName":n,"AttributeType":"S"} for n in ["pk","sk","outboxStatePk","outboxStateSk"]], KeySchema=[{"AttributeName":"pk","KeyType":"HASH"},{"AttributeName":"sk","KeyType":"RANGE"}], GlobalSecondaryIndexes=[{"IndexName":"outbox-pending-index","KeySchema":[{"AttributeName":"outboxStatePk","KeyType":"HASH"},{"AttributeName":"outboxStateSk","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}])
        db.get_waiter("table_exists").wait(TableName=TABLE)
    sqs=client("sqs")
    for name in ["view-show-analysis", "view-show-analysis-dlq"]:
        print(json.dumps(sqs.create_queue(QueueName=name)))


def seed(sequence: int) -> None:
    """Lê 16 valores sintéticos do MySQL e cria fatos/outbox identificados pela sequência."""
    start=datetime(2026,1,1,tzinfo=UTC)+timedelta(hours=sequence*4)
    conn=pymysql.connect(host=os.environ.get("DEMO_MYSQL_HOST","mysql"),port=int(os.environ.get("DEMO_MYSQL_PORT","3306")),user="root",password="local-demo-only",database="argus",ssl={"check_hostname":False})
    with conn.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='argus'")
        tables=cursor.fetchone()[0]
        for h in range(4):
            for metric,(_,value) in METRICS.items():
                cursor.execute("REPLACE INTO signal_bucket (bts,source,entity,metric,value) VALUES (%s,%s,%s,%s,%s)",(int((start+timedelta(hours=h)).timestamp()*1000),"demo","demo-channel",metric,value))
        conn.commit()
        cursor.execute("SELECT bts,metric,value FROM signal_bucket WHERE source='demo' AND bts >= %s AND bts < %s",(int(start.timestamp()*1000),int((start+timedelta(hours=4)).timestamp()*1000)))
        rows=cursor.fetchall()
    conn.close()
    db=boto3.resource("dynamodb",endpoint_url=os.environ["AWS_ENDPOINT_URL_DYNAMODB"],region_name="us-east-1",aws_access_key_id="local",aws_secret_access_key="local").Table(TABLE)
    for bts,metric,value in rows:
        observed=datetime.fromtimestamp(bts/1000,UTC)
        record=f"demo-{sequence}-{metric}-{bts}"
        db.put_item(Item={"pk":f"DATASET#dsv_demo#FACT#TS#demo-{metric}#{observed:%Y%m%d}","sk":f"T#{bts}#{record}","recordId":record,"datasetVersion":"dsv_demo","seriesId":"demo-"+metric,"observedAt":observed.isoformat(),"payload":{"metric":{"name":metric,"unit":METRICS[metric][0],"value":Decimal(str(value))}}})
    window=TimeWindow(start+timedelta(hours=3),start+timedelta(hours=4),3600)
    event=build_analysis_event("dsv_demo","QOE_FORECAST",window,created_at=window.end,forecast_model=ForecastModel("qoe-random-forest","demo"))
    db.put_item(Item=json.loads(canonical_bytes(pending_outbox(event))))
    db.put_item(Item=DynamoOutboxRepository.locator_item(event))
    print(json.dumps({"eventId":event.event_id,"mysqlTables":tables,"canonicalFacts":len(rows),"outbox":"PENDING","sequence":sequence}))


def verify(sequence: int) -> None:
    """Espera até 90 s e exige outbox publicada, resultado persistido e fila drenada."""
    db=boto3.resource("dynamodb",endpoint_url=os.environ["AWS_ENDPOINT_URL_DYNAMODB"],region_name="us-east-1",aws_access_key_id="local",aws_secret_access_key="local").Table(TABLE)
    end=datetime(2026,1,1,tzinfo=UTC)+timedelta(hours=sequence*4+4)
    event=build_analysis_event("dsv_demo","QOE_FORECAST",TimeWindow(end-timedelta(hours=1),end,3600),created_at=end,forecast_model=ForecastModel("qoe-random-forest","demo"))
    for _ in range(45):
        items=db.scan(ConsistentRead=True)["Items"]
        matching=[i for i in items if i.get("sk")=="SCOPE#demo-channel" and i.get("checkpoint",{}).get("event",{}).get("eventId")==event.event_id]
        if matching:
            pk=matching[0]["pk"]
            run=db.get_item(Key={"pk":pk,"sk":"META"},ConsistentRead=True).get("Item",{})
            result=db.get_item(Key={"pk":pk,"sk":"RESULT#demo-channel"},ConsistentRead=True).get("Item",{})
            outbox=db.get_item(Key={k:pending_outbox(event)[k] for k in ["pk","sk"]},ConsistentRead=True).get("Item",{})
            if run.get("state")=="SUCCEEDED" and result.get("result",{}).get("coverage")==1 and outbox.get("state")=="PUBLISHED":
                attrs=client("sqs").get_queue_attributes(QueueUrl=client("sqs").get_queue_url(QueueName="view-show-analysis")["QueueUrl"],AttributeNames=["ApproximateNumberOfMessages","ApproximateNumberOfMessagesNotVisible"])["Attributes"]
                if all(int(v)==0 for v in attrs.values()):
                    print(json.dumps({"eventId":event.event_id,"runId":pk,"state":"SUCCEEDED","coverage":1,"outbox":"PUBLISHED","queue":attrs,"model":"synthetic-constant","llm":"disabled"})); return
        time.sleep(2)
    raise RuntimeError("Não houve conclusão persistida e drenagem da fila em 90 s")


def invalid() -> None:
    """Envia JSON fora do contrato à fila local para observar isolamento na DLQ."""
    sqs=client("sqs"); url=sqs.get_queue_url(QueueName="view-show-analysis")["QueueUrl"]
    print(json.dumps(sqs.send_message(QueueUrl=url,MessageBody='{"demoInvalidContract":true}')))


def dlq() -> None:
    """Espera até 60 s por nossa mensagem inválida na DLQ; falha se não chegar."""
    sqs=client("sqs"); url=sqs.get_queue_url(QueueName="view-show-analysis-dlq")["QueueUrl"]
    for _ in range(6):
        response=sqs.receive_message(QueueUrl=url,WaitTimeSeconds=10,MaxNumberOfMessages=10)
        for message in response.get("Messages",[]):
            # O worker preserva somente hash/metadados na DLQ, não o payload bruto.
            if "INVALID_EVENT_CONTRACT" in message["Body"]:
                print(json.dumps({"dlq":url,"body":message["Body"],"messageId":message["MessageId"]})); return
    raise RuntimeError("Mensagem inválida ausente da DLQ")


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=["setup","seed","verify","invalid","dlq"])
    parser.add_argument("--sequence",type=int,default=1)
    args=parser.parse_args()
    if args.sequence < 1: parser.error("sequence deve ser positiva")
    {"setup":setup,"seed":lambda:seed(args.sequence),"verify":lambda:verify(args.sequence),"invalid":invalid,"dlq":dlq}[args.command]()
