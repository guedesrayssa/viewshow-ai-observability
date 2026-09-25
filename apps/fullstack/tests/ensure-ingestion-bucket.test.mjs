import assert from "node:assert/strict";
import test from "node:test";

import {
  destroyIngestionBucket,
  ensureIngestionBucket,
} from "../scripts/ensure-ingestion-bucket.mjs";

const baseEnvironment = {
  AWS_REGION: "us-east-1",
  BUCKET_NAME: "view-show-ingestion-123456789012-us-east-1",
  DEPLOYMENT_ENVIRONMENT: "learner-lab",
  EXPECTED_ACCOUNT_ID: "123456789012",
  DEPLOYMENT_NAMESPACE: "view-show",
  FRONTEND_ORIGIN: "https://producao.example.amplifyapp.com",
};

function fakeAws({
  accountId = "123456789012",
  bucketNames = [],
  bucketRegion = "None",
} = {}) {
  const calls = [];
  const run = (arguments_) => {
    calls.push(arguments_);
    if (arguments_[0] === "sts") return accountId;
    if (arguments_[0] === "s3api" && arguments_[1] === "list-buckets") {
      return bucketNames.join("\t");
    }
    if (arguments_[0] === "s3api" && arguments_[1] === "get-bucket-location") {
      return bucketRegion;
    }
    return "";
  };
  return { calls, run };
}

test("adota e reconcilia as tags de um bucket pertencente à conta sem recriá-lo", () => {
  const aws = fakeAws({ bucketNames: [baseEnvironment.BUCKET_NAME] });

  const result = ensureIngestionBucket(baseEnvironment, aws.run);

  assert.equal(result, "adopted");
  assert.deepEqual(
    aws.calls.map((arguments_) => arguments_.slice(0, 2)),
    [
      ["sts", "get-caller-identity"],
      ["s3api", "list-buckets"],
      ["s3api", "get-bucket-location"],
      ["s3api", "put-bucket-cors"],
      ["s3api", "put-bucket-tagging"],
      ["s3api", "wait"],
    ],
  );
});

test("cria, identifica e aguarda um bucket ausente em us-east-1", () => {
  const aws = fakeAws();

  const result = ensureIngestionBucket(baseEnvironment, aws.run);

  assert.equal(result, "created");
  assert.deepEqual(aws.calls[2], [
    "s3api",
    "create-bucket",
    "--bucket",
    baseEnvironment.BUCKET_NAME,
    "--region",
    "us-east-1",
  ]);
  assert.deepEqual(aws.calls[3].slice(0, 4), [
    "s3api",
    "get-bucket-location",
    "--bucket",
    baseEnvironment.BUCKET_NAME,
  ]);
  assert.deepEqual(aws.calls[4].slice(0, 4), [
    "s3api",
    "put-bucket-cors",
    "--bucket",
    baseEnvironment.BUCKET_NAME,
  ]);
  assert.deepEqual(
    JSON.parse(aws.calls[4][aws.calls[4].indexOf("--cors-configuration") + 1]),
    {
      CORSRules: [
        {
          AllowedOrigins: [baseEnvironment.FRONTEND_ORIGIN],
          AllowedMethods: ["PUT", "HEAD"],
          AllowedHeaders: ["content-type", "x-amz-checksum-sha256"],
          ExposeHeaders: ["ETag", "x-amz-checksum-sha256"],
          MaxAgeSeconds: 900,
        },
      ],
    },
  );
  assert.deepEqual(aws.calls[4].slice(-4), [
    "--expected-bucket-owner",
    baseEnvironment.EXPECTED_ACCOUNT_ID,
    "--region",
    baseEnvironment.AWS_REGION,
  ]);
  assert.deepEqual(aws.calls[5].slice(0, 4), [
    "s3api",
    "put-bucket-tagging",
    "--bucket",
    baseEnvironment.BUCKET_NAME,
  ]);
  assert.deepEqual(aws.calls[6], [
    "s3api",
    "wait",
    "bucket-exists",
    "--bucket",
    baseEnvironment.BUCKET_NAME,
    "--region",
    "us-east-1",
  ]);
});

test("remove todas as versões antes de apagar o bucket compatível", () => {
  const calls = [];
  const aws = (arguments_) => {
    calls.push(arguments_);
    if (arguments_[0] === "sts") return baseEnvironment.EXPECTED_ACCOUNT_ID;
    if (arguments_[1] === "get-bucket-tagging") {
      return JSON.stringify({
        TagSet: [
          { Key: "Projeto", Value: "view-show" },
          { Key: "ManagedBy", Value: "terraform" },
          { Key: "Componente", Value: "ingestion" },
          { Key: "Ambiente", Value: "learner-lab" },
        ],
      });
    }
    if (arguments_[1] === "list-object-versions") {
      return JSON.stringify({
        Versions: [{ Key: "dumps/a", VersionId: "version-a" }],
        DeleteMarkers: [{ Key: "dumps/b", VersionId: "marker-b" }],
      });
    }
    if (arguments_[1] === "list-multipart-uploads") return JSON.stringify({ Uploads: [] });
    return "";
  };

  const result = destroyIngestionBucket(baseEnvironment, aws);

  assert.equal(result, "destroyed");
  const deleteObjects = calls.find((arguments_) => arguments_[1] === "delete-objects");
  assert.ok(deleteObjects, "as versões devem ser apagadas antes do bucket");
  assert.deepEqual(JSON.parse(deleteObjects[deleteObjects.indexOf("--delete") + 1]), {
    Objects: [
      { Key: "dumps/a", VersionId: "version-a" },
      { Key: "dumps/b", VersionId: "marker-b" },
    ],
    Quiet: true,
  });
  assert.ok(
    calls.findIndex((arguments_) => arguments_[1] === "delete-objects") <
      calls.findIndex((arguments_) => arguments_[1] === "delete-bucket"),
    "o bucket só pode ser apagado após as versões",
  );
});

test("informa LocationConstraint ao criar fora de us-east-1", () => {
  const aws = fakeAws({ bucketRegion: "sa-east-1" });
  const environment = {
    ...baseEnvironment,
    AWS_REGION: "sa-east-1",
    BUCKET_NAME: "view-show-ingestion-123456789012-sa-east-1",
  };

  ensureIngestionBucket(environment, aws.run);

  assert.deepEqual(aws.calls[2].slice(-2), [
    "--create-bucket-configuration",
    "LocationConstraint=sa-east-1",
  ]);
});

test("recusa adoção quando a localização física diverge da região esperada", () => {
  const aws = fakeAws({
    bucketNames: [baseEnvironment.BUCKET_NAME],
    bucketRegion: "sa-east-1",
  });

  assert.throws(
    () => ensureIngestionBucket(baseEnvironment, aws.run),
    /região física.*sa-east-1.*região esperada.*us-east-1/,
  );
  assert.deepEqual(
    aws.calls.map((arguments_) => arguments_.slice(0, 2)),
    [
      ["sts", "get-caller-identity"],
      ["s3api", "list-buckets"],
      ["s3api", "get-bucket-location"],
    ],
  );
});

test("falha antes de consultar buckets quando a credencial é de outra conta", () => {
  const aws = fakeAws({ accountId: "999999999999" });

  assert.throws(
    () => ensureIngestionBucket(baseEnvironment, aws.run),
    /conta AWS ativa.*difere da conta esperada/,
  );
  assert.equal(aws.calls.length, 1);
});

test("recusa uso em produção antes de chamar a AWS", () => {
  const aws = fakeAws();

  assert.throws(
    () =>
      ensureIngestionBucket(
        { ...baseEnvironment, DEPLOYMENT_ENVIRONMENT: "production" },
        aws.run,
      ),
    /exclusivo do Learner Lab/,
  );
  assert.equal(aws.calls.length, 0);
});

test("recusa bucket fora do namespace da conta antes de chamar a AWS", () => {
  const aws = fakeAws();

  assert.throws(
    () => ensureIngestionBucket({ ...baseEnvironment, BUCKET_NAME: "outro-bucket" }, aws.run),
    /namespace seguro/,
  );
  assert.equal(aws.calls.length, 0);
});

test("recusa adotar o bucket legado mesmo quando pertence à conta", () => {
  const aws = fakeAws({ bucketNames: ["g05-s3-ingestion-123456789012-us-east-1"] });

  assert.throws(
    () =>
      ensureIngestionBucket(
        { ...baseEnvironment, BUCKET_NAME: "g05-s3-ingestion-123456789012-us-east-1" },
        aws.run,
      ),
    /namespace seguro/,
  );
  assert.equal(aws.calls.length, 0);
});

test("recusa nome que contém a conta mas não a região esperada", () => {
  const aws = fakeAws();

  assert.throws(
    () =>
      ensureIngestionBucket(
        {
          ...baseEnvironment,
          BUCKET_NAME: "view-show-ingestion-123456789012-sa-east-1-task24",
        },
        aws.run,
      ),
    /namespace seguro.*conta e região/,
  );
  assert.equal(aws.calls.length, 0);
});

test("recusa origem frontend ausente ou fora do contrato HTTPS antes de chamar a AWS", () => {
  for (const FRONTEND_ORIGIN of [
    "",
    "http://producao.example.amplifyapp.com",
    "https://*.amplifyapp.com",
    "https://producao.example.amplifyapp.com/path",
    "https://producao.example.amplifyapp.com?query=1",
  ]) {
    const aws = fakeAws();
    assert.throws(
      () => ensureIngestionBucket({ ...baseEnvironment, FRONTEND_ORIGIN }, aws.run),
      /FRONTEND_ORIGIN|origem HTTPS/,
    );
    assert.equal(aws.calls.length, 0);
  }
});

test("recusa namespace ausente ou incompatível antes de chamar a AWS", () => {
  for (const environment of [
    { ...baseEnvironment, DEPLOYMENT_NAMESPACE: "" },
    { ...baseEnvironment, DEPLOYMENT_NAMESPACE: "outro", BUCKET_NAME: baseEnvironment.BUCKET_NAME },
  ]) {
    const aws = fakeAws({ bucketNames: [baseEnvironment.BUCKET_NAME] });
    assert.throws(() => ensureIngestionBucket(environment, aws.run), /DEPLOYMENT_NAMESPACE|namespace seguro/);
    assert.equal(aws.calls.length, 0);
  }
});
