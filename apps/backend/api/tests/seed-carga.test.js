const test = require("node:test");
const assert = require("node:assert/strict");

const { enviarLoteComRetry, limparTabela } = require("../scripts/seed-carga");

test("CLEAN preserva USER# e repete somente deletes não processados", async () => {
  const batchRequests = [];
  const waits = [];
  let scans = 0;

  const documentClient = {
    async send(command) {
      if (command.constructor.name === "ScanCommand") {
        scans += 1;
        return {
          Items: [
            { pk: "USER#demo@globoplay.com", sk: "PROFILE" },
            { pk: "INC#2026-09-06T20", sk: "INCIDENT#inc-1" },
          ],
        };
      }

      const requests = command.input.RequestItems["operacional"];
      batchRequests.push(requests);
      if (batchRequests.length === 1) {
        return { UnprocessedItems: { operacional: requests } };
      }
      return { UnprocessedItems: {} };
    },
  };

  const removidos = await limparTabela("operacional", {
    documentClient,
    wait: async (tentativa) => waits.push(tentativa),
    maxAttempts: 3,
  });

  assert.equal(scans, 1);
  assert.equal(removidos, 1);
  assert.equal(batchRequests.length, 2);
  assert.deepEqual(batchRequests[1], batchRequests[0]);
  assert.deepEqual(batchRequests[0], [
    { DeleteRequest: { Key: { pk: "INC#2026-09-06T20", sk: "INCIDENT#inc-1" } } },
  ]);
  assert.deepEqual(waits, [0]);
});

test("batch write falha se ainda houver UnprocessedItems após os retries", async () => {
  const request = { DeleteRequest: { Key: { pk: "INC#bucket", sk: "INCIDENT#inc-1" } } };
  let tentativas = 0;
  const documentClient = {
    async send(command) {
      tentativas += 1;
      return { UnprocessedItems: { operacional: command.input.RequestItems.operacional } };
    },
  };

  await assert.rejects(
    enviarLoteComRetry("operacional", [request], {
      documentClient,
      wait: async () => {},
      maxAttempts: 2,
    }),
    /1 operações em operacional continuaram não processadas após 2 tentativas/,
  );
  assert.equal(tentativas, 2);
});
