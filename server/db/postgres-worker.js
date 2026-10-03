import { workerData } from "node:worker_threads";
import pg from "pg";
import { connectionConfig } from "./connection-config.js";

const { Client, types } = pg;
types.setTypeParser(20, (value) => Number(value));
const port = workerData.port;
let client;

async function connectedClient() {
  if (client) return client;
  const next = new Client(connectionConfig());
  await next.connect();
  next.on("error", () => { if (client === next) client = undefined; });
  client = next;
  return client;
}

port.on("message", async ({ id, operation, sql, values, state }) => {
  let result;
  let error;
  try {
    const connection = await connectedClient();
    const query = await connection.query({ text: sql, values: operation === "query" ? values : [] });
    result = operation === "exec" ? null : { rows: query.rows, rowCount: query.rowCount };
  } catch (caught) {
    error = caught.message;
    if (client && (caught.code === "ECONNRESET" || caught.code === "57P01")) client = undefined;
  }
  port.postMessage({ id, result, error });
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
});
