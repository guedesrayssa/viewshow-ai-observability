"""Provision the owned EKS experiment without modifying the deployed ECS stack."""

from __future__ import annotations

import argparse
import base64
import json
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[5]
NAME = "view-show-rnf-eks"
ACCOUNT = "239162056821"
REGION = "us-east-1"
OUT = ROOT / "assets/testes-carga/2026-10-06-fechamento-aws/eks-native"
TAGS = {
    "Projeto": "view-show",
    "Purpose": "rnf-synthetic-tests",
    "Owner": "g05-artifact",
}


def save(name, value):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(value, default=str, indent=2) + "\n")


def require_owned(cluster):
    if cluster.get("tags", {}).get("Purpose") != TAGS["Purpose"]:
        raise RuntimeError(
            "Refusing to operate on a cluster not owned by this experiment"
        )


def nodes(session):
    eks = session.client("eks")
    cluster = eks.describe_cluster(name=NAME)["cluster"]
    require_owned(cluster)
    if cluster["status"] != "ACTIVE":
        raise RuntimeError("Cluster is not ACTIVE yet")
    discovery = json.loads((OUT / "network-discovery.json").read_text())
    private = []
    for table in discovery["routeTables"]:
        if any(
            route.get("NatGatewayId")
            and route.get("DestinationCidrBlock") == "0.0.0.0/0"
            for route in table["Routes"]
        ):
            private += [
                association["SubnetId"]
                for association in table["Associations"]
                if "SubnetId" in association
            ]
    if len(private) < 2:
        raise RuntimeError("At least two existing NAT-routed subnets are required")
    ec2 = session.client("ec2")
    # Reuse the service network identity already authorized by private VPC
    # endpoints; do not edit its rules or the existing ECS service.
    service = session.client("ecs").describe_services(
        cluster="view-show-iac-cluster", services=["view-show-iac-api-service"]
    )["services"][0]
    endpoint_groups = service["networkConfiguration"]["awsvpcConfiguration"][
        "securityGroups"
    ]
    user_data = """MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="RNF_NODE"

--RNF_NODE
Content-Type: application/node.eks.aws

apiVersion: node.eks.aws/v1alpha1
kind: NodeConfig
spec:
  instance:
    localStorage:
      strategy: RAID0

--RNF_NODE--
"""
    templates = ec2.describe_launch_templates(
        Filters=[{"Name": "launch-template-name", "Values": [NAME]}]
    )["LaunchTemplates"]
    if templates:
        template = templates[0]
        if not any(
            tag["Key"] == "Purpose" and tag["Value"] == TAGS["Purpose"]
            for tag in template.get("Tags", [])
        ):
            raise RuntimeError("Launch template ownership mismatch")
    else:
        template = ec2.create_launch_template(
            LaunchTemplateName=NAME,
            LaunchTemplateData={
                "SecurityGroupIds": [
                    cluster["resourcesVpcConfig"]["clusterSecurityGroupId"],
                    *endpoint_groups,
                ],
                "UserData": base64.b64encode(user_data.encode()).decode(),
                "MetadataOptions": {
                    "HttpEndpoint": "enabled",
                    "HttpTokens": "required",
                    "HttpPutResponseHopLimit": 2,
                },
                "BlockDeviceMappings": [
                    {
                        "DeviceName": "/dev/xvda",
                        "Ebs": {
                            "VolumeSize": 100,
                            "VolumeType": "gp3",
                            "Encrypted": True,
                            "DeleteOnTermination": True,
                        },
                    }
                ],
                "TagSpecifications": [
                    {
                        "ResourceType": "instance",
                        "Tags": [
                            {"Key": key, "Value": value} for key, value in TAGS.items()
                        ],
                    }
                ],
            },
            TagSpecifications=[
                {
                    "ResourceType": "launch-template",
                    "Tags": [
                        {"Key": key, "Value": value} for key, value in TAGS.items()
                    ],
                }
            ],
        )["LaunchTemplate"]
    request = {
        "clusterName": NAME,
        "nodegroupName": "rnf-workloads",
        "subnets": sorted(set(private)),
        "nodeRole": f"arn:aws:iam::{ACCOUNT}:role/LabRole",
        "instanceTypes": ["i3.large"],
        "amiType": "AL2023_x86_64_STANDARD",
        "capacityType": "ON_DEMAND",
        "scalingConfig": {"minSize": 2, "maxSize": 2, "desiredSize": 2},
        "launchTemplate": {
            "id": template["LaunchTemplateId"],
            "version": str(template["LatestVersionNumber"]),
        },
        "tags": TAGS,
    }
    save("create-nodegroup-request.json", request)
    try:
        result = eks.create_nodegroup(**request)["nodegroup"]
    except eks.exceptions.ResourceInUseException:
        result = eks.describe_nodegroup(
            clusterName=NAME, nodegroupName="rnf-workloads"
        )["nodegroup"]
    save("nodegroup-state.json", result)
    print(
        json.dumps({"nodegroup": result["nodegroupName"], "status": result["status"]})
    )


def resources(session):
    dynamo = session.client("dynamodb")
    source = session.client("ecs").describe_task_definition(
        taskDefinition="view-show-iac-api-task:1"
    )["taskDefinition"]
    env = {
        value["name"]: value["value"]
        for value in source["containerDefinitions"][0]["environment"]
    }
    definition = dynamo.describe_table(TableName=env["OPERATIONAL_TABLE_NAME"])["Table"]
    table_request = {
        "TableName": NAME,
        "AttributeDefinitions": definition["AttributeDefinitions"],
        "KeySchema": definition["KeySchema"],
        "BillingMode": "PAY_PER_REQUEST",
        "Tags": [{"Key": key, "Value": value} for key, value in TAGS.items()],
    }
    if definition.get("GlobalSecondaryIndexes"):
        table_request["GlobalSecondaryIndexes"] = [
            {key: index[key] for key in ("IndexName", "KeySchema", "Projection")}
            for index in definition["GlobalSecondaryIndexes"]
        ]
    save("create-table-request.json", table_request)
    try:
        dynamo.create_table(**table_request)
    except dynamo.exceptions.ResourceInUseException:
        arn = dynamo.describe_table(TableName=NAME)["Table"]["TableArn"]
        tags = {
            tag["Key"]: tag["Value"]
            for tag in dynamo.list_tags_of_resource(ResourceArn=arn)["Tags"]
        }
        if tags.get("Purpose") != TAGS["Purpose"]:
            raise RuntimeError("Existing DynamoDB table is not owned")
    bucket = NAME + "-" + ACCOUNT
    s3 = session.client("s3")
    try:
        s3.create_bucket(Bucket=bucket)
    except s3.exceptions.BucketAlreadyOwnedByYou:
        tags = s3.get_bucket_tagging(Bucket=bucket)["TagSet"]
        if not any(
            tag["Key"] == "Purpose" and tag["Value"] == TAGS["Purpose"] for tag in tags
        ):
            raise RuntimeError("Existing S3 bucket is not owned")
    s3.put_bucket_tagging(
        Bucket=bucket,
        Tagging={
            "TagSet": [{"Key": key, "Value": value} for key, value in TAGS.items()]
        },
    )
    s3.put_bucket_versioning(
        Bucket=bucket, VersioningConfiguration={"Status": "Enabled"}
    )
    s3.put_public_access_block(
        Bucket=bucket,
        PublicAccessBlockConfiguration={
            key: True
            for key in (
                "BlockPublicAcls",
                "IgnorePublicAcls",
                "BlockPublicPolicy",
                "RestrictPublicBuckets",
            )
        },
    )
    s3.put_bucket_encryption(
        Bucket=bucket,
        ServerSideEncryptionConfiguration={
            "Rules": [
                {"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}
            ]
        },
    )
    glue = session.client("glue")
    database = NAME.replace("-", "_")
    try:
        glue.create_database(
            DatabaseInput={
                "Name": database,
                "Description": "Owned synthetic RNF EKS experiment",
                "LocationUri": f"s3://{bucket}/curated/",
            }
        )
    except glue.exceptions.AlreadyExistsException:
        if (
            glue.get_database(Name=database)["Database"].get("Description")
            != "Owned synthetic RNF EKS experiment"
        ):
            raise RuntimeError("Glue database ownership mismatch")
    athena = session.client("athena")
    try:
        athena.create_work_group(
            Name=NAME,
            Description="Owned synthetic RNF EKS experiment",
            Configuration={
                "ResultConfiguration": {
                    "OutputLocation": f"s3://{bucket}/athena/",
                    "EncryptionConfiguration": {"EncryptionOption": "SSE_S3"},
                },
                "PublishCloudWatchMetricsEnabled": True,
            },
            Tags=[{"Key": key, "Value": value} for key, value in TAGS.items()],
        )
    except ClientError as error:
        if not any(
            text in str(error).lower() for text in ("already exists", "already created")
        ):
            raise
        if (
            athena.get_work_group(WorkGroup=NAME)["WorkGroup"].get("Description")
            != "Owned synthetic RNF EKS experiment"
        ):
            raise RuntimeError("Athena workgroup ownership mismatch") from error
    sqs = session.client("sqs")
    analysis = sqs.create_queue(
        QueueName=NAME + "-analysis",
        Attributes={
            "VisibilityTimeout": "300",
            "ReceiveMessageWaitTimeSeconds": "20",
            "SqsManagedSseEnabled": "true",
        },
        tags=TAGS,
    )["QueueUrl"]
    result = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "account": ACCOUNT,
        "region": REGION,
        "cluster": NAME,
        "namespace": "view-show-rnf",
        "importsNamespace": "view-show-rnf-imports",
        "operationalTable": NAME,
        "bucket": bucket,
        "glueDatabase": database,
        "athenaWorkgroup": NAME,
        "athenaOutput": f"s3://{bucket}/athena/",
        "analysisQueueUrl": analysis,
        "scope": "separate test data; no ECS service, active dataset or original storage modified",
    }
    dlq = sqs.create_queue(
        QueueName=NAME + "-incremental-dlq.fifo",
        Attributes={
            "FifoQueue": "true",
            "ContentBasedDeduplication": "false",
            "VisibilityTimeout": "300",
            "SqsManagedSseEnabled": "true",
        },
        tags=TAGS,
    )["QueueUrl"]
    dlq_arn = sqs.get_queue_attributes(QueueUrl=dlq, AttributeNames=["QueueArn"])[
        "Attributes"
    ]["QueueArn"]
    fifo = sqs.create_queue(
        QueueName=NAME + "-incremental.fifo",
        Attributes={
            "FifoQueue": "true",
            "ContentBasedDeduplication": "false",
            "VisibilityTimeout": "300",
            "ReceiveMessageWaitTimeSeconds": "20",
            "SqsManagedSseEnabled": "true",
            "RedrivePolicy": json.dumps(
                {"deadLetterTargetArn": dlq_arn, "maxReceiveCount": 5}
            ),
        },
        tags=TAGS,
    )["QueueUrl"]
    result.update(incrementalQueueUrl=fifo, incrementalDlqUrl=dlq)
    save("resources.json", result)
    print(json.dumps(result))


def edge(session):
    discovery = json.loads((OUT / "network-discovery.json").read_text())
    request = json.loads((OUT / "create-cluster-request.json").read_text())
    ec2 = session.client("ec2")
    groups = ec2.describe_security_groups(
        Filters=[
            {"Name": "vpc-id", "Values": [discovery["vpcId"]]},
            {"Name": "group-name", "Values": [NAME + "-alb"]},
        ]
    )["SecurityGroups"]
    if groups:
        group = groups[0]
        if not any(
            tag["Key"] == "Purpose" and tag["Value"] == TAGS["Purpose"]
            for tag in group.get("Tags", [])
        ):
            raise RuntimeError("ALB security group ownership mismatch")
        sg = group["GroupId"]
    else:
        sg = ec2.create_security_group(
            GroupName=NAME + "-alb",
            Description="Owned RNF EKS ALB",
            VpcId=discovery["vpcId"],
            TagSpecifications=[
                {
                    "ResourceType": "security-group",
                    "Tags": [
                        {"Key": key, "Value": value} for key, value in TAGS.items()
                    ],
                }
            ],
        )["GroupId"]
        ec2.authorize_security_group_ingress(
            GroupId=sg,
            IpPermissions=[
                {
                    "IpProtocol": "tcp",
                    "FromPort": 80,
                    "ToPort": 80,
                    "IpRanges": [
                        {
                            "CidrIp": request["resourcesVpcConfig"][
                                "publicAccessCidrs"
                            ][0],
                            "Description": "Synthetic test generator",
                        }
                    ],
                }
            ],
        )
    elb = session.client("elbv2")
    try:
        load_balancer = elb.describe_load_balancers(Names=[NAME])["LoadBalancers"][0]
    except elb.exceptions.LoadBalancerNotFoundException:
        load_balancer = elb.create_load_balancer(
            Name=NAME,
            Subnets=[
                subnet["SubnetId"]
                for subnet in discovery["subnets"]
                if subnet["MapPublicIpOnLaunch"]
            ],
            SecurityGroups=[sg],
            Scheme="internet-facing",
            Type="application",
            Tags=[{"Key": key, "Value": value} for key, value in TAGS.items()],
        )["LoadBalancers"][0]
    try:
        target = elb.describe_target_groups(Names=[NAME + "-api"])["TargetGroups"][0]
    except elb.exceptions.TargetGroupNotFoundException:
        target = elb.create_target_group(
            Name=NAME + "-api",
            Protocol="HTTP",
            Port=3000,
            VpcId=discovery["vpcId"],
            TargetType="ip",
            HealthCheckProtocol="HTTP",
            HealthCheckPath="/health",
            HealthCheckIntervalSeconds=15,
            HealthCheckTimeoutSeconds=5,
            HealthyThresholdCount=2,
            UnhealthyThresholdCount=3,
            Matcher={"HttpCode": "200"},
            Tags=[{"Key": key, "Value": value} for key, value in TAGS.items()],
        )["TargetGroups"][0]
    elb.modify_target_group_attributes(
        TargetGroupArn=target["TargetGroupArn"],
        Attributes=[{"Key": "deregistration_delay.timeout_seconds", "Value": "15"}],
    )
    if not elb.describe_listeners(LoadBalancerArn=load_balancer["LoadBalancerArn"])[
        "Listeners"
    ]:
        elb.create_listener(
            LoadBalancerArn=load_balancer["LoadBalancerArn"],
            Protocol="HTTP",
            Port=80,
            DefaultActions=[
                {"Type": "forward", "TargetGroupArn": target["TargetGroupArn"]}
            ],
        )
    result = {
        "loadBalancerArn": load_balancer["LoadBalancerArn"],
        "baseUrl": "http://" + load_balancer["DNSName"],
        "securityGroupId": sg,
        "targetGroupArn": target["TargetGroupArn"],
        "networkScope": "dedicated ALB, HTTP, generator CIDR only; no Amplify/API Gateway migration",
    }
    save("edge.json", result)
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["resources", "nodes", "edge", "status"])
    args = parser.parse_args()
    session = boto3.Session(region_name=REGION)
    if session.client("sts").get_caller_identity()["Account"] != ACCOUNT:
        raise RuntimeError("AWS account mismatch")
    if args.mode == "resources":
        resources(session)
    elif args.mode == "nodes":
        nodes(session)
    elif args.mode == "edge":
        edge(session)
    else:
        cluster = session.client("eks").describe_cluster(name=NAME)["cluster"]
        require_owned(cluster)
        save(
            "cluster-state.json",
            {
                key: cluster.get(key)
                for key in [
                    "name",
                    "arn",
                    "version",
                    "status",
                    "createdAt",
                    "resourcesVpcConfig",
                    "accessConfig",
                    "health",
                ]
            },
        )
        print(json.dumps({"cluster": NAME, "status": cluster["status"]}))


if __name__ == "__main__":
    main()
