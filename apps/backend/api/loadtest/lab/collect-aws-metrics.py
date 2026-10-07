"""Export actual CloudWatch series for the explicitly identified load-test window."""
import argparse
import json
from pathlib import Path

import boto3

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--start',required=True);p.add_argument('--end',required=True)
p.add_argument('--output',type=Path,required=True);p.add_argument('--expected-account',required=True)
a=p.parse_args()
if boto3.client('sts',region_name='us-east-1').get_caller_identity()['Account']!=a.expected_account:
 raise SystemExit('AWS account mismatch')
queries=[]
def metric(identifier,namespace,name,dimensions,stat='Average'):
 queries.append({'Id':identifier,'MetricStat':{'Metric':{'Namespace':namespace,'MetricName':name,'Dimensions':[{'Name':k,'Value':v} for k,v in dimensions.items()]},'Period':60,'Stat':stat},'ReturnData':True})
family={'ClusterName':'view-show-iac-cluster','TaskDefinitionFamily':'view-show-ingestion-import'}
for identifier,name in [('cpu','CpuUtilized'),('cpu_reserved','CpuReserved'),('memory','MemoryUtilized'),('memory_reserved','MemoryReserved')]:metric(identifier,'ECS/ContainerInsights',name,family)
for i,stage in enumerate(['STARTING','RESTORING','VALIDATING','INGESTING','PROJECTING','ARCHIVING','PUBLISHING']):metric('stage'+str(i),'view-show/Ingestion','StageDurationMs',{'command':'import-dump','stage':stage},'Maximum')
metric('ddb_write','AWS/DynamoDB','ConsumedWriteCapacityUnits',{'TableName':'view-show-iac-operacional'},'Sum')
metric('ddb_throttled','AWS/DynamoDB','WriteThrottleEvents',{'TableName':'view-show-iac-operacional'},'Sum')
r=boto3.client('cloudwatch',region_name='us-east-1').get_metric_data(MetricDataQueries=queries,StartTime=a.start,EndTime=a.end,ScanBy='TimestampAscending')
while r.get('NextToken'):
 nxt=boto3.client('cloudwatch',region_name='us-east-1').get_metric_data(MetricDataQueries=queries,StartTime=a.start,EndTime=a.end,ScanBy='TimestampAscending',NextToken=r['NextToken'])
 for target,new in zip(r['MetricDataResults'],nxt['MetricDataResults']):target['Timestamps'].extend(new['Timestamps']);target['Values'].extend(new['Values'])
 r['NextToken']=nxt.get('NextToken')
result={'start':a.start,'end':a.end,'account':a.expected_account,'queries':queries,'response':r,'interpretation':'absent stages are not zero duration; application metrics may not be emitted on external cancellation'}
a.output.write_text(json.dumps(result,default=lambda v:v.isoformat(),indent=2)+'\n')
print(json.dumps({x['Id']:len(x['Values']) for x in r['MetricDataResults']}))
