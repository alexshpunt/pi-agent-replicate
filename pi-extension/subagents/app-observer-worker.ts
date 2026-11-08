import { parentPort, workerData } from "node:worker_threads";
import { appProcessInfo } from "./app-core.ts";

try {
  parentPort!.postMessage({ result: appProcessInfo(workerData.context, workerData.paneId) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
